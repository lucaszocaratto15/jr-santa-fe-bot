/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { spawn as nodeSpawn } from 'node:child_process';
import {
  type LearnExclusion,
  type LearnGenerateResult,
  type LearnInsightBatch,
  type LearnSample,
  type LearnState,
  type LearnStatus,
  type ObservedWorkSource,
} from '@/common/types/agent/learnTypes';
import type { OsEncryption } from '@process/services/jr/auth';
import type { JrRelayConfig } from '@process/services/jr/bootstrap';
import { generateInsights } from './insights';
import { createLearnSettings, sanitizeExclusions, type LearnSettingsData, type LearnSettings } from './learnSettings';
import { DEFAULT_EXCLUSIONS, isExcluded, redactTitle, redactUrl } from './privacyFilter';
import { createSampler, type Sampler } from './sampler';
import { createInsightStore, createSampleStore, encryptionUsable, learnProfileDir } from './sampleStore';
import { JR_APP_LABEL, LEARN_TICK_MS } from './summary';
import { createWorkflows } from './workflow';

export const LEARN_IDLE_SKIP_S = 120;
export const LEARN_HOURLY_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** 30 min of 15 s samples for the daily run, 5 min for "Gerar insights agora". */
export const MIN_DAILY_SAMPLES = 120;
export const MIN_MANUAL_SAMPLES = 20;
export const MAX_DAILY_ATTEMPTS = 3;
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
  settings?: LearnSettings;
};

export type LearnService = {
  init(): Promise<LearnState>;
  refreshProfile(): Promise<void>;
  setConsent(enabled: boolean): Promise<LearnState>;
  workflows: ReturnType<typeof createWorkflows>;
  /** Main-only receipt closure. Capture before asynchronous work, complete only after a verified action. */
  beginWorkEvent(source: ObservedWorkSource, context?: { origin: string }): (() => Promise<void>) | null;
  state(): LearnState;
  /**
   * Pause collection indefinitely; only an explicit resume restarts it.
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

/** Work observation is opt-in per authenticated employee; pausing stops collection until resumed. */
export function createLearnService(deps: LearnServiceDeps): LearnService {
  const settings = deps.settings ?? createLearnSettings(deps.root);
  const samplesFor = (id: string) => createSampleStore(learnProfileDir(deps.root, id), deps.encryption);
  // Legacy observations are never attributed or replayed; their existing expiry and explicit wipe still apply.
  const legacySamples = createSampleStore(deps.root, deps.encryption);
  const purgeProfileSamples = async () => {
    const profiles = join(deps.root, 'profiles');
    const names = await readdir(profiles).catch((): string[] => []);
    await Promise.all([
      legacySamples.purge(deps.now()),
      ...names
        .filter((name) => /^[a-f0-9]{64}$/.test(name))
        .map((name) => createSampleStore(join(profiles, name), deps.encryption).purge(deps.now())),
    ]);
  };
  const insights = createInsightStore(deps.root, deps.encryption);

  let data: LearnSettingsData | null = null;

  let rawHours = 0;
  let rawHoursOwner: string | null = null;
  let transitionStatus: 'disabled' | 'paused' | null = null;
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
    if (transitionStatus) return transitionStatus;
    if (!data?.enabled || !data.consentUserId || data.consentUserId !== deps.currentUser()?.id) return 'disabled';
    if (data.paused) return 'paused';
    return 'active';
  };

  const computeState = (): LearnState => {
    const status = deriveStatus();
    return {
      ownerId: deps.currentUser()?.id ?? null,
      workEventsEnabled: Boolean(
        data?.enabled && data.consentUserId === deps.currentUser()?.id && data.workEventsConsentVersion === 1
      ),
      status,
      unavailableReason: status === 'unavailable' ? unavailableReason() : null,
      pausedUntil: null,
      pauseAvailable: status === 'active',
      titles:
        deps.platform === 'darwin' && (!deps.screenTitlesGranted() || titlelessRun >= TITLELESS_SAMPLES_FOR_APP_ONLY)
          ? 'app-only'
          : 'full',
      samplerError,
      rawHours: rawHoursOwner === deps.currentUser()?.id ? rawHours : 0,
      lastInsightsAt: data?.lastSummaryAt ?? null,
      activeSince: status === 'active' ? activeSince : null,
    };
  };

  const stopSampler = () => {
    sampler?.stop();
    sampler = null;
  };

  /** No foreground polling runs before consent or while paused. */
  const syncTimers = (status: LearnStatus) => {
    const wantsTick = !disposed && status === 'active';
    if (wantsTick && tickTimer === null) {
      tickTimer = deps.setInterval(() => void service.tick(), LEARN_TICK_MS);
    } else if (!wantsTick && tickTimer !== null) {
      deps.clearInterval(tickTimer);
      tickTimer = null;
    }
    // Pausing or revoking consent also terminates the foreground sampler.
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
    const id = deps.currentUser()?.id;
    if (!id) {
      rawHours = 0;
      rawHoursOwner = null;
      return;
    }
    try {
      const hours = await samplesFor(id).hours();
      if (deps.currentUser()?.id !== id) return;
      rawHoursOwner = id;
      rawHours = hours;
    } catch {
      /* Keep only this profile's last count. */
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
    const ownerId = deps.currentUser()?.id;
    if (!ownerId) {
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
    if (gen !== generation || deriveStatus() !== 'active' || !data || deps.currentUser()?.id !== ownerId) return;
    // Exclusions match the raw sample (an e-mail rule needs the address), then secrets are
    // redacted before anything is written: no codes, documents or url parameters on disk.
    if (isExcluded(sample, data.exclusions)) return;
    const url = redactUrl(sample.url);
    await samplesFor(ownerId).append({
      app: sample.app,
      title: redactTitle(sample.title),
      ...(url ? { url } : {}),
      t: deps.now(),
    });
    await refreshRawHours();
    publish();
  };

  const runInsights = (minSamples: number): Promise<LearnGenerateResult> => {
    if (runInFlight) return Promise.resolve({ ok: false, code: 'busy' });
    const gen = generation;
    const abort = new AbortController();
    runAbort = abort;
    const run = (async (): Promise<LearnGenerateResult> => {
      const ownerId = deps.currentUser()?.id;
      if (!ownerId || data?.consentUserId !== ownerId) return { ok: false, code: 'unavailable' };
      const now = deps.now();
      // Exclusions added after collection also cover what is already on disk.
      const exclusions = data?.exclusions ?? [];
      const recent = (
        await samplesFor(ownerId).readSince(Math.max(now - DAY_MS, data?.consentedAt ?? now), now)
      ).filter((sample) => !isExcluded(sample, exclusions));
      if (recent.length < minSamples) return { ok: false, code: 'no-data' };
      if (gen !== generation || deps.currentUser()?.id !== ownerId) return { ok: false, code: 'unavailable' };
      const result = await generateInsights({
        samples: recent,
        connection: deps.connection(),
        now: deps.now,
        request: deps.request,
        signal: abort.signal,
      });
      if (gen !== generation || deps.currentUser()?.id !== ownerId) return { ok: false, code: 'unavailable' };
      if (!result.ok) return result;
      result.batch.ownerUserId = ownerId;
      if (!result.batch.ownerUserId || data?.consentUserId !== result.batch.ownerUserId)
        return { ok: false, code: 'unavailable' };
      await insights.add(result.batch);
      if (gen !== generation || deps.currentUser()?.id !== ownerId) return { ok: false, code: 'unavailable' };
      await write({ lastSummaryAt: result.batch.createdAt });
      if (gen !== generation || deps.currentUser()?.id !== ownerId) return { ok: false, code: 'unavailable' };
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
    if (!data || !['active', 'paused'].includes(deriveStatus()) || !deps.currentUser()) return;
    const now = deps.now();
    if (data.lastSummaryAt !== null && now - data.lastSummaryAt < DAY_MS) return;
    const day = localDay(now);
    const attempts = data.attempts.day === day ? data.attempts.count : 0;
    if (attempts >= MAX_DAILY_ATTEMPTS) return;
    if (
      (await samplesFor(deps.currentUser()!.id).count(Math.max(now - DAY_MS, data.consentedAt ?? now), now)) <
      MIN_DAILY_SAMPLES
    )
      return;
    await write({ attempts: { day, count: attempts + 1 } });
    await runInsights(MIN_DAILY_SAMPLES);
  };

  const workflows = createWorkflows({
    root: deps.root,
    encryption: deps.encryption,
    currentUser: deps.currentUser,
    collecting: () => deriveStatus() === 'active',
    now: deps.now,
  });
  const service: LearnService = {
    workflows,
    beginWorkEvent(source, context) {
      const ownerId = deps.currentUser()?.id;
      let origin: string | undefined;
      if (source === 'browser.download') {
        try {
          const url = new URL(context?.origin ?? '');
          if (
            !['https:', 'http:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.origin !== context?.origin
          )
            return null;
          origin = url.origin;
        } catch {
          return null;
        }
      }
      const excluded = () =>
        isExcluded({ app: JR_APP_LABEL, title: null, ...(origin ? { url: origin } : {}) }, data?.exclusions ?? []);
      if (
        disposed ||
        !ownerId ||
        deriveStatus() !== 'active' ||
        data?.workEventsConsentVersion !== 1 ||
        !['erp.read', 'browser.download'].includes(source) ||
        excluded()
      )
        return null;
      const gen = generation;
      const id = randomUUID();
      let completed = false;
      const current = () =>
        !disposed &&
        gen === generation &&
        deps.currentUser()?.id === ownerId &&
        deriveStatus() === 'active' &&
        data?.workEventsConsentVersion === 1 &&
        !excluded();
      return async () => {
        if (completed) return;
        completed = true;
        if (!current()) return;
        try {
          await workflows.observe(source, id, current);
        } catch (error) {
          if (!current() || (error instanceof Error && error.message === 'workflow_observation_stale')) return;
          throw error;
        }
      };
    },
    async init() {
      await load();
      await refreshRawHours();
      if (hourlyTimer === null && !disposed) {
        hourlyTimer = deps.setInterval(() => void service.hourly(), LEARN_HOURLY_MS);
      }
      await Promise.all([purgeProfileSamples(), insights.purge(deps.now()), workflows.purge()]).catch(() => {});
      await refreshRawHours();
      return publish();
    },

    state: computeState,

    async refreshProfile() {
      const gen = ++generation;
      runAbort?.abort();
      stopSampler();
      transitionStatus = 'disabled';
      publish();
      await load();
      await refreshRawHours();
      if (gen !== generation) return;
      transitionStatus = null;
      publish();
    },

    async setConsent(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('invalid_consent');
      const id = deps.currentUser()?.id;
      if (!id || unavailableReason()) throw new Error('learn_unavailable');
      const gen = ++generation;
      transitionStatus = 'disabled';
      runAbort?.abort();
      stopSampler();
      publish();
      if (!data) await load();
      if (deps.currentUser()?.id !== id) throw new Error('learn_identity_changed');
      await write({
        enabled,
        consentUserId: id,
        consentedAt: enabled ? deps.now() : data!.consentedAt,
        workEventsConsentVersion: enabled ? 1 : 0,
        paused: false,
        lastSummaryAt: null,
        attempts: { day: '', count: 0 },
      });
      if (gen !== generation || deps.currentUser()?.id !== id) throw new Error('learn_identity_changed');
      transitionStatus = null;
      return publish();
    },

    async pause() {
      if (deriveStatus() !== 'active') return computeState();
      const gen = ++generation;
      transitionStatus = 'paused';
      stopSampler();
      publish();
      await write({ paused: true });
      if (gen === generation) transitionStatus = null;
      return publish();
    },

    async resume() {
      if (!data?.enabled || data.consentUserId !== deps.currentUser()?.id) return publish();
      const gen = ++generation;
      transitionStatus = 'disabled';
      publish();
      await write({ paused: false });
      if (gen !== generation) return computeState();
      transitionStatus = null;
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
      const userId = deps.currentUser()?.id;
      const gen = generation;
      if (!userId) return [];
      const batches = await insights.list();
      if (gen !== generation || deps.currentUser()?.id !== userId) return [];
      return batches.filter((batch) => batch.ownerUserId === userId);
    },

    async deleteInsight(id) {
      const userId = deps.currentUser()?.id;
      const gen = generation;
      const mine = (await insights.list()).find((batch) => batch.id === id && batch.ownerUserId === userId);
      if (!userId || gen !== generation || deps.currentUser()?.id !== userId || !mine)
        throw new Error('insight_not_found');
      await insights.remove(id);
    },

    async generateNow() {
      if (!['active', 'paused'].includes(deriveStatus())) return { ok: false, code: 'unavailable' };
      return runInsights(MIN_MANUAL_SAMPLES);
    },

    async wipeSamples() {
      const ownerId = deps.currentUser()?.id;
      const gen = generation;
      if (!ownerId) throw new Error('learn_unavailable');
      await tickInFlight?.catch(() => {});
      if (gen !== generation || deps.currentUser()?.id !== ownerId) throw new Error('learn_identity_changed');
      await samplesFor(ownerId).wipe();
      if (gen !== generation || deps.currentUser()?.id !== ownerId) throw new Error('learn_identity_changed');
      await legacySamples.wipe();
      if (gen !== generation || deps.currentUser()?.id !== ownerId) throw new Error('learn_identity_changed');
      rawHoursOwner = ownerId;
      rawHours = 0;
      return publish();
    },

    async tick() {
      if (tickInFlight || disposed) return;
      const gen = generation;
      const run = (async () => {
        if (!data) await load();
        // Retention is enforced on every tick too, not only by the hourly timer.
        await purgeProfileSamples().catch(() => {});
        // A pause remains in effect until this employee explicitly resumes.
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
        await Promise.all([purgeProfileSamples(), insights.purge(deps.now()), workflows.purge()]);
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
