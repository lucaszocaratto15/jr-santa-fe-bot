/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { spawn as nodeSpawn } from 'node:child_process';
import {
  LEARN_TERM_VERSION,
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
import {
  createLearnSettings,
  latestAccept,
  sanitizeExclusions,
  type ConsentEvent,
  type LearnSettingsData,
} from './learnSettings';
import { DEFAULT_EXCLUSIONS, isExcluded } from './privacyFilter';
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
const MAX_PAUSE_MINUTES = 24 * 60;

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
  /** Hook for the "Manual da função" plan; best effort, errors swallowed. */
  onRevoke: () => Promise<void>;
  /** Test seam for the model call. */
  request?: typeof fetch;
};

export type LearnService = {
  init(): Promise<LearnState>;
  state(): LearnState;
  accept(termVersion: string): Promise<LearnState>;
  /** Re-enable after "Desligar" when the stored accept is for the current term. */
  turnOn(): Promise<LearnState>;
  pause(minutes: number | null): Promise<LearnState>;
  resume(): Promise<LearnState>;
  turnOff(): Promise<LearnState>;
  revoke(): Promise<LearnState>;
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

export const LEARN_ERRORS = {
  termVersion: 'LEARN_TERM_VERSION',
  unavailable: 'LEARN_UNAVAILABLE',
  needsConsent: 'LEARN_NEEDS_CONSENT',
  badPause: 'LEARN_BAD_PAUSE',
} as const;

const localDay = (t: number): string => {
  const date = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * Consent-gated observer. Nothing is spawned, sampled or written before an accept of the
 * current term version; pausing, turning off, locking the screen or being idle stop sampling.
 */
export function createLearnService(deps: LearnServiceDeps): LearnService {
  const settings = createLearnSettings(deps.root);
  const samples = createSampleStore(deps.root, deps.encryption);
  const insights = createInsightStore(deps.root, deps.encryption);

  let data: LearnSettingsData | null = null;
  let events: ConsentEvent[] = [];
  let rawHours = 0;
  let samplerError = false;
  let sampler: Sampler | null = null;
  let tickTimer: unknown = null;
  let hourlyTimer: unknown = null;
  /** Bumped by revoke/turnOff/dispose: in-flight work from an older generation writes nothing. */
  let generation = 0;
  let tickInFlight: Promise<void> | null = null;
  let runInFlight: Promise<LearnGenerateResult> | null = null;
  let runAbort: AbortController | null = null;
  let lastEmitted = '';
  let disposed = false;

  const unavailableReason = (): LearnState['unavailableReason'] => {
    if (deps.platform !== 'win32' && deps.platform !== 'darwin') return 'platform';
    if (!encryptionUsable(deps.encryption)) return 'encryption';
    return null;
  };

  const currentAccept = (): ConsentEvent | null => {
    const accept = latestAccept(events);
    return accept?.termVersion === LEARN_TERM_VERSION ? accept : null;
  };

  const deriveStatus = (): LearnStatus => {
    if (unavailableReason()) return 'unavailable';
    if (!data?.enabled) return 'off';
    const accept = latestAccept(events);
    if (!accept) return 'off';
    if (accept.termVersion !== LEARN_TERM_VERSION) return 'needs-consent';
    if (data.paused && (data.pausedUntil === null || deps.now() < data.pausedUntil)) return 'paused';
    return 'active';
  };

  const computeState = (): LearnState => {
    const status = deriveStatus();
    const accept = latestAccept(events);
    return {
      status,
      unavailableReason: status === 'unavailable' ? unavailableReason() : null,
      pausedUntil: status === 'paused' ? (data?.pausedUntil ?? null) : null,
      titles: deps.platform === 'darwin' && !deps.screenTitlesGranted() ? 'app-only' : 'full',
      samplerError,
      rawHours,
      acceptedVersion: accept?.termVersion ?? null,
      acceptedAt: accept?.at ?? null,
      lastInsightsAt: data?.lastSummaryAt ?? null,
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
    events = await settings.consent();
  };

  const write = async (patch: Partial<LearnSettingsData>) => {
    data = await settings.write(patch);
  };

  const requireAvailable = () => {
    if (unavailableReason()) throw new Error(LEARN_ERRORS.unavailable);
  };

  /** Invalidate in-flight work synchronously, before any await of the caller. */
  const invalidate = () => {
    generation += 1;
    runAbort?.abort();
  };

  /** Stop collection and wait for any in-flight tick/insights run of the old generation. */
  const quiesce = async () => {
    invalidate();
    stopSampler();
    await tickInFlight?.catch(() => {});
    await runInFlight?.catch(() => {});
  };

  const collect = async (gen: number): Promise<void> => {
    if (deriveStatus() !== 'active') return;
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
      sample = { app: foreground.app, title: foreground.title };
    }
    // Paused, turned off or revoked while the child answered: drop it.
    if (gen !== generation || deriveStatus() !== 'active' || !data) return;
    if (isExcluded(sample, data.exclusions)) return;
    await samples.append({ ...sample, t: deps.now() });
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
      const recent = await samples.readSince(now - DAY_MS);
      if (recent.length < minSamples) return { ok: false, code: 'no-data' };
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
    if (!data || !currentAccept() || !data.enabled || deriveStatus() === 'unavailable') return;
    const now = deps.now();
    const since = data.lastSummaryAt ?? Date.parse(currentAccept()!.at);
    if (Number.isFinite(since) && now - since < DAY_MS) return;
    const day = localDay(now);
    const attempts = data.attempts.day === day ? data.attempts.count : 0;
    if (attempts >= MAX_DAILY_ATTEMPTS) return;
    if ((await samples.count(now - DAY_MS)) < MIN_DAILY_SAMPLES) return;
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

    async accept(termVersion) {
      requireAvailable();
      if (termVersion !== LEARN_TERM_VERSION) throw new Error(LEARN_ERRORS.termVersion);
      if (!data) await load();
      const user = deps.currentUser();
      await settings.appendConsent({
        type: 'accept',
        termVersion,
        at: new Date(deps.now()).toISOString(),
        user: user ? { id: user.id, name: user.name } : null,
      });
      events = await settings.consent();
      await write({ enabled: true, paused: false, pausedUntil: null });
      samplerError = false;
      return publish();
    },

    async turnOn() {
      requireAvailable();
      if (!data) await load();
      if (!currentAccept()) throw new Error(LEARN_ERRORS.needsConsent);
      await write({ enabled: true, paused: false, pausedUntil: null });
      samplerError = false;
      return publish();
    },

    async pause(minutes) {
      if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_PAUSE_MINUTES)) {
        throw new Error(LEARN_ERRORS.badPause);
      }
      const status = deriveStatus();
      if (status !== 'active' && status !== 'paused') return computeState();
      await write({ paused: true, pausedUntil: minutes === null ? null : deps.now() + minutes * 60_000 });
      return publish();
    },

    async resume() {
      if (!data) await load();
      if (data?.paused) await write({ paused: false, pausedUntil: null });
      // "Tentar de novo" after the sampler gave up: start a fresh child on the next tick.
      if (samplerError) {
        stopSampler();
        samplerError = false;
      }
      return publish();
    },

    async turnOff() {
      invalidate();
      await write({ enabled: false, paused: false, pausedUntil: null });
      await quiesce();
      samplerError = false;
      return publish();
    },

    async revoke() {
      invalidate();
      if (!data) await load();
      await write({ enabled: false, paused: false, pausedUntil: null });
      await quiesce();
      await samples.wipe();
      await insights.wipe();
      const accepted = latestAccept(events);
      if (accepted) {
        const user = deps.currentUser();
        await settings.appendConsent({
          type: 'revoke',
          termVersion: accepted.termVersion,
          at: new Date(deps.now()).toISOString(),
          user: user ? { id: user.id, name: user.name } : null,
        });
        events = await settings.consent();
      }
      await write({ lastSummaryAt: null, attempts: { day: '', count: 0 } });
      rawHours = 0;
      samplerError = false;
      try {
        await deps.onRevoke();
      } catch {
        // Best effort: the local wipe already happened.
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
      if (unavailableReason() || !currentAccept()) return { ok: false, code: 'unavailable' };
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
        // A timed pause that ended (also after sleep) resumes here.
        if (data?.paused && data.pausedUntil !== null && deps.now() >= data.pausedUntil) {
          await write({ paused: false, pausedUntil: null });
          publish();
        }
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
