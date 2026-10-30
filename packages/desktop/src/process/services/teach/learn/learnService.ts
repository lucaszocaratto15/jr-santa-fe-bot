/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { spawn as nodeSpawn } from 'node:child_process';
import {
  type LearnExclusion,
  type LearnGenerateResult,
  type LearnInsightBatch,
  type LearnSample,
  type LearnState,
  type LearnStatus,
} from '@/common/types/agent/learnTypes';
import type { OsEncryption } from '@process/services/jr/auth';
import type { JrRelayConfig } from '@process/services/jr/bootstrap';
import { generateInsights } from './insights';
import { createLearnSettings, sanitizeExclusions, type LearnSettingsData } from './learnSettings';
import { DEFAULT_EXCLUSIONS, isExcluded, redactTitle, redactUrl } from './privacyFilter';
import { createSampler, type Sampler } from './sampler';
import { createInsightStore, createSampleStore, encryptionUsable } from './sampleStore';
import { JR_APP_LABEL, LEARN_TICK_MS } from './summary';

export const LEARN_IDLE_SKIP_S = 120;
export const LEARN_HOURLY_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** 30 min of 15 s samples for the daily run, 5 min for "Gerar insights agora". */
export const MIN_DAILY_SAMPLES = 120;
export const MIN_MANUAL_SAMPLES = 20;
export const MAX_DAILY_ATTEMPTS = 3;
/** The single daily pause: it lasts this long and then sampling resumes by itself. */
export const PAUSE_MINUTES = 15;
/** darwin: this many title-less OS samples in a row with the permission granted → report app-only. */
export const TITLELESS_SAMPLES_FOR_APP_ONLY = 20;

export type LearnServiceDeps = {
  /** `userData/jr-learn`. */
  root: string;
  encryption: OsEncryption;
  platform: NodeJS.Platform;
  spawn: typeof nodeSpawn;
  now: () => number;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  idleSeconds: () => number;
  isLocked: () => boolean;
  /** A JR Bot window has focus: sample the in-app browser instead of the OS child. */
  jrFocused: () => boolean;
  /** The page attached to the JR Bot browser, url already sanitized. */
  jrBrowserPage: () => { url: string; title: string } | null;
  /** darwin: Screen Recording granted (window titles readable). */
  screenTitlesGranted: () => boolean;
  currentUser: () => { id: string; name: string } | null;
  connection: () => JrRelayConfig | null;
  emit: (state: LearnState) => void;
  /** Test seam for the model call. */
  request?: typeof fetch;
};

export type LearnService = {
  init(): Promise<LearnState>;
  state(): LearnState;
  /**
   * The one pause of the local day (PAUSE_MINUTES, auto-resume). A second call the same day is
   * a silent no-op. Aprender has no off switch.
   */
  pause(): Promise<LearnState>;
  /** Ends today's pause early, or restarts the sampler after it gave up. */
  resume(): Promise<LearnState>;
  getExclusions(): Promise<LearnExclusion[]>;
  setExclusions(rules: LearnExclusion[]): Promise<LearnExclusion[]>;
  /** Puts back any removed default rule, keeping the user's own rules. */
  restoreDefaultExclusions(): Promise<LearnExclusion[]>;
  listInsights(): Promise<LearnInsightBatch[]>;
  deleteInsight(id: string): Promise<void>;
  generateNow(): Promise<LearnGenerateResult>;
  wipeSamples(): Promise<LearnState>;
  tick(): Promise<void>;
  hourly(): Promise<void>;
  dispose(): void;
};

const pad = (n: number) => String(n).padStart(2, '0');

const localDay = (t: number): string => {
  const date = new Date(t);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * Always-on observer: it samples from launch for every employee, with no consent step and no
 * off switch (the Data Notice informs; the stated purpose is understanding the work to help the
 * employee, never performance evaluation or time control). Only the one daily pause, a locked
 * screen or idleness stop sampling. Pause state lives in memory; the only thing persisted is the
 * local date of today's pause.
 */
export function createLearnService(deps: LearnServiceDeps): LearnService {
  const settings = createLearnSettings(deps.root);
  const samples = createSampleStore(deps.root, deps.encryption);
  const insights = createInsightStore(deps.root, deps.encryption);

  let data: LearnSettingsData | null = null;
  /** Today's pause: memory only, a restart simply resumes. */
  let pausedUntil: number | null = null;
  let rawHours = 0;
  let samplerError = false;
  let sampler: Sampler | null = null;
  let tickTimer: unknown = null;
  let hourlyTimer: unknown = null;
  /** Bumped by dispose: in-flight work from an older generation writes nothing. */
  let generation = 0;
  let tickInFlight: Promise<void> | null = null;
  let runInFlight: Promise<LearnGenerateResult> | null = null;
  let runAbort: AbortController | null = null;
  let lastEmitted = '';
  let activeSince: number | null = null;
  let disposed = false;
  /** darwin: consecutive OS samples without a title although the permission reads as granted. */
  let titlelessRun = 0;

  const unavailableReason = (): LearnState['unavailableReason'] => {
    if (deps.platform !== 'win32' && deps.platform !== 'darwin') return 'platform';
    if (!encryptionUsable(deps.encryption)) return 'encryption';
    return null;
  };

  const deriveStatus = (): LearnStatus => {
    if (unavailableReason()) return 'unavailable';
    if (pausedUntil !== null && deps.now() < pausedUntil) return 'paused';
    return 'active';
  };

  const computeState = (): LearnState => {
    const status = deriveStatus();
    return {
      status,
      unavailableReason: status === 'unavailable' ? unavailableReason() : null,
      pausedUntil: status === 'paused' ? pausedUntil : null,
      pauseAvailable: status !== 'unavailable' && data?.pauseDay !== localDay(deps.now()),
      titles:
        deps.platform === 'darwin' && (!deps.screenTitlesGranted() || titlelessRun >= TITLELESS_SAMPLES_FOR_APP_ONLY)
          ? 'app-only'
          : 'full',
      samplerError,
      rawHours,
      lastInsightsAt: data?.lastSummaryAt ?? null,
      activeSince: status === 'active' ? activeSince : null,
    };
  };

  const stopSampler = () => {
    sampler?.stop();
    sampler = null;
  };

  /** Tick timer runs while active or paused (to notice the end of a timed pause). */
  const syncTimers = (status: LearnStatus) => {
    const wantsTick = !disposed && (status === 'active' || status === 'paused');
    if (wantsTick && tickTimer === null) {
      tickTimer = deps.setInterval(() => void service.tick(), LEARN_TICK_MS);
    } else if (!wantsTick && tickTimer !== null) {
      deps.clearInterval(tickTimer);
      tickTimer = null;
    }
    // The child lives while active or paused, and dies otherwise.
    if (!wantsTick) stopSampler();
  };

  const publish = (): LearnState => {
    const status = deriveStatus();
    if (status !== 'active') activeSince = null;
    else activeSince ??= deps.now();
    const state = computeState();
    syncTimers(state.status);
    const serialized = JSON.stringify(state);
    if (serialized !== lastEmitted) {
      lastEmitted = serialized;
      deps.emit(state);
    }
    return state;
  };

  const refreshRawHours = async () => {
    try {
      rawHours = await samples.hours();
    } catch {
      // Keep the last value.
    }
  };

  const load = async () => {
    data = await settings.read();
  };

  const write = async (patch: Partial<LearnSettingsData>) => {
    data = await settings.write(patch);
  };

  const trackTitles = (title: string | null) => {
    if (deps.platform !== 'darwin') return;
    const before = titlelessRun >= TITLELESS_SAMPLES_FOR_APP_ONLY;
    titlelessRun = title === null ? titlelessRun + 1 : 0;
    if (before !== titlelessRun >= TITLELESS_SAMPLES_FOR_APP_ONLY) publish();
  };

  const collect = async (gen: number): Promise<void> => {
    if (deriveStatus() !== 'active') return;
    // Only an employee who is logged in is observed.
    if (!deps.currentUser()) {
      stopSampler();
      return;
    }
    if (deps.isLocked() || deps.idleSeconds() >= LEARN_IDLE_SKIP_S) return;
    let sample: Omit<LearnSample, 't'>;
    if (deps.jrFocused()) {
      // Never the JR window title (it shows the conversation name): only the browser page.
      const page = deps.jrBrowserPage();
      sample = page?.url
        ? { app: JR_APP_LABEL, title: page.title || null, url: page.url }
        : { app: JR_APP_LABEL, title: null };
    } else {
      sampler ??= createSampler({ spawn: deps.spawn, platform: deps.platform, now: deps.now });
      const foreground = (await sampler?.sample()) ?? null;
      const failed = sampler?.failed() ?? false;
      if (failed !== samplerError) {
        samplerError = failed;
        publish();
      }
      if (!foreground) return;
      trackTitles(foreground.title);
      sample = { app: foreground.app, title: foreground.title };
    }
    // Paused while the child answered: drop it.
    if (gen !== generation || deriveStatus() !== 'active' || !data) return;
    // Exclusions match the raw sample (an e-mail rule needs the address), then secrets are
    // redacted before anything is written: no codes, documents or url parameters on disk.
    if (isExcluded(sample, data.exclusions)) return;
    const url = redactUrl(sample.url);
    await samples.append({ app: sample.app, title: redactTitle(sample.title), ...(url ? { url } : {}), t: deps.now() });
    await refreshRawHours();
    publish();
  };

  const runInsights = (minSamples: number): Promise<LearnGenerateResult> => {
    if (runInFlight) return Promise.resolve({ ok: false, code: 'busy' });
    const gen = generation;
    const abort = new AbortController();
    runAbort = abort;
    const run = (async (): Promise<LearnGenerateResult> => {
      const now = deps.now();
      // Exclusions added after collection also cover what is already on disk.
      const exclusions = data?.exclusions ?? [];
      const recent = (await samples.readSince(now - DAY_MS, now)).filter((sample) => !isExcluded(sample, exclusions));
      if (recent.length < minSamples) return { ok: false, code: 'no-data' };
      if (gen !== generation) return { ok: false, code: 'unavailable' };
      const result = await generateInsights({
        samples: recent,
        connection: deps.connection(),
        now: deps.now,
        request: deps.request,
        signal: abort.signal,
      });
      if (gen !== generation) return { ok: false, code: 'unavailable' };
      if (!result.ok) return result;
      await insights.add(result.batch);
      await write({ lastSummaryAt: result.batch.createdAt });
      publish();
      return result;
    })();
    runInFlight = run;
    void run.finally(() => {
      if (runInFlight === run) {
        runInFlight = null;
        runAbort = null;
      }
    });
    return run;
  };

  const dailyCheck = async () => {
    if (!data || deriveStatus() === 'unavailable' || !deps.currentUser()) return;
    const now = deps.now();
    if (data.lastSummaryAt !== null && now - data.lastSummaryAt < DAY_MS) return;
    const day = localDay(now);
    const attempts = data.attempts.day === day ? data.attempts.count : 0;
    if (attempts >= MAX_DAILY_ATTEMPTS) return;
    if ((await samples.count(now - DAY_MS, now)) < MIN_DAILY_SAMPLES) return;
    await write({ attempts: { day, count: attempts + 1 } });
    await runInsights(MIN_DAILY_SAMPLES);
  };

  const service: LearnService = {
    async init() {
      await load();
      await refreshRawHours();
      if (hourlyTimer === null && !disposed) {
        hourlyTimer = deps.setInterval(() => void service.hourly(), LEARN_HOURLY_MS);
      }
      await Promise.all([samples.purge(deps.now()), insights.purge(deps.now())]).catch(() => {});
      await refreshRawHours();
      return publish();
    },

    state: computeState,

    async pause() {
      if (!data) await load();
      const today = localDay(deps.now());
      // One per local day; the control is hidden afterwards, so a refused call says nothing.
      if (deriveStatus() !== 'active' || data!.pauseDay === today) return computeState();
      // Set before the write is awaited, so a concurrent call sees the pause and cannot extend it.
      pausedUntil = deps.now() + PAUSE_MINUTES * 60_000;
      await write({ pauseDay: today });
      return publish();
    },

    async resume() {
      pausedUntil = null;
      // "Tentar de novo" after the sampler gave up: start a fresh child on the next tick.
      if (samplerError) {
        stopSampler();
        samplerError = false;
      }
      return publish();
    },

    async getExclusions() {
      if (!data) await load();
      return data!.exclusions;
    },

    async setExclusions(rules) {
      await write({ exclusions: sanitizeExclusions(rules) });
      return data!.exclusions;
    },

    async restoreDefaultExclusions() {
      if (!data) await load();
      const custom = data!.exclusions.filter((rule) => !rule.builtin);
      await write({ exclusions: [...DEFAULT_EXCLUSIONS, ...custom] });
      return data!.exclusions;
    },

    async listInsights() {
      if (unavailableReason()) return [];
      return insights.list();
    },

    async deleteInsight(id) {
      await insights.remove(id);
    },

    async generateNow() {
      if (deriveStatus() === 'unavailable') return { ok: false, code: 'unavailable' };
      return runInsights(MIN_MANUAL_SAMPLES);
    },

    async wipeSamples() {
      await tickInFlight?.catch(() => {});
      await samples.wipe();
      rawHours = 0;
      return publish();
    },

    async tick() {
      if (tickInFlight || disposed) return;
      const gen = generation;
      const run = (async () => {
        if (!data) await load();
        // Retention is enforced on every tick too, not only by the hourly timer.
        await samples.purge(deps.now()).catch(() => {});
        // The pause ended (also after sleep): resume, and let the daily pause come back at midnight.
        if (pausedUntil !== null && deps.now() >= pausedUntil) pausedUntil = null;
        publish();
        await collect(gen);
      })();
      tickInFlight = run;
      try {
        await run;
      } catch {
        // A failed tick only loses that sample.
      } finally {
        tickInFlight = null;
      }
    },

    async hourly() {
      try {
        await Promise.all([samples.purge(deps.now()), insights.purge(deps.now())]);
      } catch {
        // Retried next hour.
      }
      await refreshRawHours();
      publish();
      try {
        await dailyCheck();
      } catch {
        // A failed attempt is counted; the next hour retries.
      }
    },

    dispose() {
      disposed = true;
      generation += 1;
      runAbort?.abort();
      if (tickTimer !== null) deps.clearInterval(tickTimer);
      if (hourlyTimer !== null) deps.clearInterval(hourlyTimer);
      tickTimer = null;
      hourlyTimer = null;
      stopSampler();
    },
  };

  return service;
}
