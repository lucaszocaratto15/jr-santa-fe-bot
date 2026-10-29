/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Manual da função" in main: builds the employee's drafts (taught tasks always; observed
 * activities and weekly indicators only with the current Aprender consent), publishes the
 * items the employee approves, and remembers what was published or dismissed in
 * `userData/jr-handbook/state.json`. Screenshots are read from disk only to publish them to
 * the company server or to show them to the employee; they never go to the model.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile as fsReadFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  HandbookActivityBody,
  HandbookDraft,
  HandbookDraftBody,
  HandbookDraftsResult,
  HandbookFrequency,
  HandbookIndicatorsBody,
  HandbookKind,
  HandbookPayload,
  HandbookPublished,
  HandbookRoleSummary,
  HandbookSource,
  HandbookView,
} from '@/common/types/agent/handbookTypes';
import { LEARN_TERM_VERSION, type LearnInsightBatch } from '@/common/types/agent/learnTypes';
import type { HandbookClient } from '@process/services/jr/handbookClient';
import type { LearnService } from '../learn/learnService';
import { TAUGHT_SKILL_NAME_RE } from '../recording/skillDraft';
import { readTaughtTask } from '../recording/taskSkillFile';
import {
  activitiesFromInsights,
  activityFromSkill,
  draftHash,
  normalizeTitle,
  recentBatches,
  weeklyIndicators,
} from './draftBuilder';
import { activityFlowchart, roleFlowchart } from './flowchart';

export const HANDBOOK_DIRNAME = 'jr-handbook';
const MAX_SHOT_BYTES = 300 * 1024;
const MAX_STEPS = 100;
const MAX_STEP_TEXT = 1000;
const MAX_CONFIRM = 20;
const SHOT_FILE_RE = /^(\d{1,3})\.jpg$/;
/**
 * Images of one publish, in raw bytes. The server caps a publish request at 6 MB so a slow
 * upload still ends within its 30 s request timeout; 4 MB of JPEGs is about 5.4 MB in base64.
 * Steps past the budget are published as text only.
 */
export const MAX_PUBLISH_MEDIA_BYTES = 4 * 1024 * 1024;
/** Retry interval of a pending learn-items withdrawal. */
export const WITHDRAW_RETRY_MS = 3_600_000;

type PublishedEntry = { itemId: string; hash: string; kind: HandbookKind; source: HandbookSource; title: string };
type HandbookState = {
  published: Record<string, PublishedEntry>;
  dismissed: Record<string, string>;
  /**
   * Set when an Aprender revoke could not reach the server. Retried at startup, when the
   * login is restored, hourly while set, and on the next drafts/mine call.
   */
  pendingWithdrawLearn?: boolean;
};

export type HandbookServiceDeps = {
  client: HandbookClient;
  /** The user skills dir (where taught `jr-tarefa-*` skills are installed). */
  skillsDir: () => Promise<string>;
  /** Candidate dirs holding a skill's screenshots, in order of preference. */
  shotsDirs: (skill: string, skillsDir: string) => string[];
  learn: () => Pick<LearnService, 'state' | 'listInsights'> | null;
  stateFile: string;
  readFile?: (file: string) => Promise<Buffer>;
  now?: () => number;
  /** Raw image budget of one publish (default MAX_PUBLISH_MEDIA_BYTES). */
  maxPublishMediaBytes?: number;
};

export type HandbookService = {
  drafts(): Promise<HandbookDraftsResult>;
  publish(key: string, edited: HandbookDraftBody, keepShots: number[]): Promise<void>;
  dismiss(key: string): Promise<void>;
  withdraw(itemId: string): Promise<void>;
  withdrawLearnItems(): Promise<void>;
  /** Retry a pending learn-items withdrawal now (no-op when none is pending). */
  retryPendingWithdraw(): Promise<void>;
  /** Retry a pending withdrawal now and every `intervalMs` while one stays pending. Returns a stop function. */
  startWithdrawRetries(intervalMs?: number): () => void;
  mine(): Promise<HandbookView>;
  media(id: string): Promise<string>;
  draftShot(key: string, shot: number): Promise<string>;
  preview(body: HandbookActivityBody): string;
  adminRoles(): Promise<HandbookRoleSummary[]>;
  adminRole(key: string): Promise<HandbookView>;
};

type SourceDraft = Omit<HandbookDraft, 'hash' | 'publishedItemId' | 'status'> & { shotsDir: string | null };

const emptyState = (): HandbookState => ({ published: {}, dismissed: {} });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toDataUrl = (base64: string): string => `data:image/jpeg;base64,${base64}`;

/** Attach Mermaid sources so the renderer never has to import main code. */
export function withFlowcharts(payload: HandbookPayload): HandbookView {
  const activities = payload.items.map((item) => item.body);
  return {
    ...payload,
    roleFlowchart: roleFlowchart(activities, payload.role?.title),
    flowcharts: Object.fromEntries(payload.items.map((item) => [item.id, activityFlowchart(item.body)])),
  };
}

const FREQUENCIES = new Set<HandbookFrequency>(['daily', 'weekly', 'occasional']);
const clip = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const nonNegative = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : 0;

/** Keep only the known fields of an activity edited in the renderer. */
function sanitizeActivity(edited: unknown, source: HandbookActivityBody): HandbookActivityBody {
  if (!record(edited)) throw new Error('invalid');
  const frequency = FREQUENCIES.has(edited.frequency as HandbookFrequency)
    ? (edited.frequency as HandbookFrequency)
    : source.frequency;
  const steps = (Array.isArray(edited.steps) ? edited.steps : [])
    .slice(0, MAX_STEPS)
    .filter(record)
    .map((step) =>
      Object.assign(
        { text: clip(step.text, MAX_STEP_TEXT) },
        Number.isInteger(step.shot) ? { shot: step.shot as number } : {}
      )
    )
    .filter((step) => step.text);
  const title = clip(edited.title, 120);
  if (!title) throw new Error('invalid');
  return {
    title,
    description: clip(edited.description, 2000),
    frequency,
    steps,
    confirmBefore: (Array.isArray(edited.confirmBefore) ? edited.confirmBefore : [])
      .slice(0, MAX_CONFIRM)
      .map((item) => clip(item, 300))
      .filter(Boolean),
    ...(source.skillName ? { skillName: source.skillName } : {}),
  };
}

function sanitizeIndicators(edited: unknown, source: HandbookIndicatorsBody): HandbookIndicatorsBody {
  if (!record(edited)) throw new Error('invalid');
  return {
    weekStart: source.weekStart,
    activities: (Array.isArray(edited.activities) ? edited.activities : [])
      .filter(record)
      .slice(0, 50)
      .map((entry) => ({
        title: clip(entry.title, 120),
        timesPerWeek: nonNegative(entry.timesPerWeek),
        minutesPerRun: nonNegative(entry.minutesPerRun),
      }))
      .filter((entry) => entry.title),
    timePerApp: (Array.isArray(edited.timePerApp) ? edited.timePerApp : [])
      .filter(record)
      .slice(0, 50)
      .map((entry) => ({ app: clip(entry.app, 120), minutesPerDay: nonNegative(entry.minutesPerDay) }))
      .filter((entry) => entry.app),
  };
}

export function createHandbookService(deps: HandbookServiceDeps): HandbookService {
  const now = deps.now ?? Date.now;
  const readFile = deps.readFile ?? ((file: string) => fsReadFile(file));
  let writes: Promise<void> = Promise.resolve();

  const loadState = async (): Promise<HandbookState> => {
    try {
      const value: unknown = JSON.parse(await fsReadFile(deps.stateFile, 'utf8'));
      if (!record(value) || !record(value.published) || !record(value.dismissed)) return emptyState();
      return value as HandbookState;
    } catch {
      return emptyState();
    }
  };

  /** Serialized read-modify-write with an atomic rename. */
  const updateState = (change: (state: HandbookState) => void): Promise<void> => {
    const run = writes.then(async () => {
      const state = await loadState();
      change(state);
      await mkdir(path.dirname(deps.stateFile), { recursive: true, mode: 0o700 });
      const temp = `${deps.stateFile}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
      await rename(temp, deps.stateFile);
    });
    writes = run.catch(() => {});
    return run;
  };

  const learnAllowed = (): boolean => deps.learn()?.state().acceptedVersion === LEARN_TERM_VERSION;

  const listShots = async (dirs: string[]): Promise<{ dir: string | null; shots: number[] }> => {
    for (const dir of dirs) {
      try {
        // eslint-disable-next-line no-await-in-loop -- the first dir with shots wins
        const names = await readdir(dir);
        const shots = names
          .map((name) => SHOT_FILE_RE.exec(name)?.[1])
          .filter((n): n is string => n !== undefined)
          .map(Number)
          .toSorted((a, b) => a - b);
        if (shots.length > 0) return { dir, shots };
      } catch {
        // Missing dir: try the next one.
      }
    }
    return { dir: null, shots: [] };
  };

  const taughtDrafts = async (): Promise<SourceDraft[]> => {
    let skillsDir: string;
    let names: string[];
    try {
      skillsDir = await deps.skillsDir();
      names = (await readdir(skillsDir)).filter((name) => TAUGHT_SKILL_NAME_RE.test(name)).toSorted();
    } catch {
      return [];
    }
    const drafts = await Promise.all(
      names.map(async (name): Promise<SourceDraft | null> => {
        try {
          const task = await readTaughtTask(skillsDir, name);
          const { dir, shots } = await listShots(deps.shotsDirs(name, skillsDir));
          const { shots: used, ...body } = activityFromSkill(task, shots);
          return { key: `taught:${name}`, kind: 'activity', source: 'taught', body, shots: used, shotsDir: dir };
        } catch {
          return null;
        }
      })
    );
    return drafts.filter((draft): draft is SourceDraft => draft !== null);
  };

  const learnDrafts = async (): Promise<SourceDraft[]> => {
    if (!learnAllowed()) return [];
    const service = deps.learn();
    if (!service) return [];
    const batches = await service.listInsights().catch((): LearnInsightBatch[] => []);
    const timestamp = now();
    const drafts: SourceDraft[] = activitiesFromInsights(recentBatches(batches, timestamp)).map(
      (body): SourceDraft => ({
        key: `learn:${normalizeTitle(body.title)}`,
        kind: 'activity',
        source: 'learn',
        body,
        shots: [],
        shotsDir: null,
      })
    );
    const indicators = weeklyIndicators(batches, timestamp);
    if (indicators) {
      drafts.push({
        key: `indicators:${indicators.weekStart}`,
        kind: 'indicators',
        source: 'learn',
        body: indicators,
        shots: [],
        shotsDir: null,
      });
    }
    return drafts;
  };

  const sources = async (): Promise<SourceDraft[]> => [...(await taughtDrafts()), ...(await learnDrafts())];

  /** Drop the local traces of observed (learn) items once the server withdrew them. */
  const clearLearnLocal = (state: HandbookState) => {
    delete state.pendingWithdrawLearn;
    for (const [key, entry] of Object.entries(state.published)) {
      if (entry.source === 'learn') delete state.published[key];
    }
    for (const key of Object.keys(state.dismissed)) {
      if (!key.startsWith('taught:')) delete state.dismissed[key];
    }
  };

  let retryIntervalMs: number | null = null;
  let retryTimer: ReturnType<typeof setInterval> | null = null;
  let retrying: Promise<void> | null = null;

  const disarmRetry = () => {
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = null;
  };

  const armRetry = () => {
    if (retryIntervalMs === null || retryTimer) return;
    retryTimer = setInterval(() => {
      void retryPendingWithdraw();
    }, retryIntervalMs);
    retryTimer.unref?.();
  };

  const retryPendingWithdraw = (): Promise<void> => {
    if (retrying) return retrying;
    retrying = (async () => {
      const state = await loadState();
      if (!state.pendingWithdrawLearn) {
        disarmRetry();
        return;
      }
      try {
        await deps.client.withdrawLearn();
      } catch {
        // Still offline, blocked or outside hours: the hourly timer tries again.
        armRetry();
        return;
      }
      disarmRetry();
      await updateState(clearLearnLocal);
    })().finally(() => {
      retrying = null;
    });
    return retrying;
  };

  const findSource = async (key: string): Promise<SourceDraft> => {
    const source = (await sources()).find((draft) => draft.key === key);
    if (!source) throw new Error('not_found');
    if (source.source === 'learn' && !learnAllowed()) throw new Error('needs_consent');
    return source;
  };

  const readShot = async (dir: string | null, shot: number): Promise<Buffer | null> => {
    if (!dir || !Number.isInteger(shot) || shot < 1) return null;
    const file = path.join(dir, `${shot}.jpg`);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_SHOT_BYTES) return null;
      return await readFile(file);
    } catch {
      return null;
    }
  };

  return {
    async drafts() {
      await retryPendingWithdraw();
      const state = await loadState();
      const payload = await deps.client.mine();
      const drafts: HandbookDraft[] = [];
      for (const source of await sources()) {
        const hash = draftHash(source.body, source.shots);
        const published = state.published[source.key];
        if (published?.hash === hash || state.dismissed[source.key] === hash) continue;
        const { shotsDir: _dir, ...draft } = source;
        drafts.push({
          ...draft,
          hash,
          publishedItemId: published?.itemId ?? null,
          status: published ? 'changed' : 'new',
        });
      }
      const published: HandbookPublished[] = Object.entries(state.published).map(([key, entry]) => ({
        key,
        itemId: entry.itemId,
        kind: entry.kind,
        title: entry.title,
      }));
      return { role: payload.role, drafts, published };
    },

    async publish(key, edited, keepShots) {
      const source = await findSource(key);
      const state = await loadState();
      const itemId = state.published[key]?.itemId ?? randomUUID();
      const hash = draftHash(source.body, source.shots);
      let body: object;
      const media: Array<{ id: string; base64: string }> = [];
      let title: string;
      if (source.kind === 'activity') {
        const activity = sanitizeActivity(edited, source.body as HandbookActivityBody);
        const keep = new Set(keepShots.filter((n) => source.shots.includes(n)));
        const images = await Promise.all(
          activity.steps.map((step) =>
            step.shot !== undefined && keep.has(step.shot) ? readShot(source.shotsDir, step.shot) : null
          )
        );
        // Media ids are assigned in step order once every file is read, within the budget.
        const budget = deps.maxPublishMediaBytes ?? MAX_PUBLISH_MEDIA_BYTES;
        let mediaBytes = 0;
        const steps = activity.steps.map((step, index) => {
          const data = images[index];
          if (!data || mediaBytes + data.length > budget) return { text: step.text };
          mediaBytes += data.length;
          const mediaId = randomUUID();
          media.push({ id: mediaId, base64: data.toString('base64') });
          return { text: step.text, mediaId };
        });
        body = { ...activity, steps };
        title = activity.title;
      } else {
        body = sanitizeIndicators(edited, source.body as HandbookIndicatorsBody);
        title = (source.body as HandbookIndicatorsBody).weekStart;
      }
      // Nothing is stored locally unless the server accepted the item (no_role, offline...).
      await deps.client.publish({ id: itemId, kind: source.kind, source: source.source, body, media });
      await updateState((next) => {
        next.published[key] = { itemId, hash, kind: source.kind, source: source.source, title };
        delete next.dismissed[key];
      });
    },

    async dismiss(key) {
      const source = (await sources()).find((draft) => draft.key === key);
      if (!source) return;
      const hash = draftHash(source.body, source.shots);
      await updateState((state) => {
        state.dismissed[key] = hash;
      });
    },

    async withdraw(itemId) {
      await deps.client.remove(itemId);
      await updateState((state) => {
        for (const [key, entry] of Object.entries(state.published)) {
          if (entry.itemId === itemId) delete state.published[key];
        }
      });
    },

    async withdrawLearnItems() {
      try {
        await deps.client.withdrawLearn();
      } catch (error) {
        await updateState((state) => {
          state.pendingWithdrawLearn = true;
        });
        armRetry();
        throw error;
      }
      disarmRetry();
      await updateState(clearLearnLocal);
    },

    retryPendingWithdraw: () => retryPendingWithdraw(),

    startWithdrawRetries(intervalMs = WITHDRAW_RETRY_MS) {
      retryIntervalMs = intervalMs;
      void retryPendingWithdraw();
      return () => {
        retryIntervalMs = null;
        disarmRetry();
      };
    },

    async mine() {
      await retryPendingWithdraw();
      return withFlowcharts(await deps.client.mine());
    },

    async media(id) {
      const { base64 } = await deps.client.media(id);
      return toDataUrl(base64);
    },

    async draftShot(key, shot) {
      const source = await findSource(key);
      if (!source.shots.includes(shot)) throw new Error('not_found');
      const data = await readShot(source.shotsDir, shot);
      if (!data) throw new Error('not_found');
      return toDataUrl(data.toString('base64'));
    },

    preview: (body) => activityFlowchart(sanitizeActivity(body, body)),

    adminRoles: () => deps.client.adminRoles(),

    async adminRole(key) {
      return withFlowcharts(await deps.client.adminRole(key));
    },
  };
}
