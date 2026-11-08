/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Manual da função" in main: builds the employee's items (taught tasks, observed activities and
 * weekly indicators) and publishes every new or changed one automatically on each sync. The
 * employee reviews afterwards: edit a published item (the edit is republished, sanitized) or hide
 * it (withdrawn and not republished until its source changes). State lives in
 * `userData/jr-handbook/state.json`. Screenshots are read from disk only to publish them to the
 * company server or to show them to the employee; they never go to the model.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile as fsReadFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  HandbookActivityBody,
  HandbookDraft,
  HandbookDraftBody,
  HandbookDraftsResult,
  HandbookHidden,
  HandbookFrequency,
  HandbookIndicatorsBody,
  HandbookKind,
  HandbookPayload,
  HandbookPublished,
  HandbookRoleSummary,
  HandbookSource,
  HandbookView,
} from '@/common/types/agent/handbookTypes';
import type { Lesson } from '@/common/types/agent/lessonTypes';
import type { LearnInsightBatch } from '@/common/types/agent/learnTypes';
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
import { scrubText } from './scrub';

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
/** Interval of the background sync (auto-publish and pending withdrawal retry). */
export const SYNC_INTERVAL_MS = 3_600_000;
/** Errors that make the rest of a sync pointless (offline, no role, no permission): retried next sync. */
const STOP_SYNC_RE = /(^|\W)(unavailable|no_role|forbidden)$/;

type PublishedEntry = {
  itemId: string;
  /**
   * Identity of the source the item was published from (never the employee's edit): the full
   * content hash for taught tasks, the normalized title / week for observed items.
   */
  hash: string;
  /** Full content hash of the source at the last publish; observed items refresh silently when it moves. */
  contentHash?: string;
  kind: HandbookKind;
  source: HandbookSource;
  title: string;
  /** The employee's edit of an activity, reopened by the editor until the source changes. */
  edited?: HandbookActivityBody;
  keepShots?: number[];
};
type HandbookState = {
  published: Record<string, PublishedEntry>;
  /** Hidden items: key → source hash at the time. Hidden until the hash changes. */
  dismissed: Record<string, string>;
  /** Items the server refused for good (not offline/no role): skipped until their content changes. */
  failed?: Record<string, { hash: string; failedAt: number }>;
  /** Role of the last successful read, so the Manual opens offline. */
  role?: { key: string; title: string } | null;
  /**
   * Set when an Aprender revoke could not reach the server. Retried at startup, when the
   * login is restored, every sync interval while set, and on the next drafts/mine call.
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
  /** Active lessons of a taught task, in store order. */
  lessonsFor?: (skill: string) => Promise<Lesson[]>;
  stateFile: string;
  readFile?: (file: string) => Promise<Buffer>;
  now?: () => number;
  /** Raw image budget of one publish (default MAX_PUBLISH_MEDIA_BYTES). */
  maxPublishMediaBytes?: number;
  /** Called once per sync that auto-published something (the "Seu Manual foi atualizado" notice). */
  onPublished?: (count: number) => void;
};

export type HandbookService = {
  drafts(): Promise<HandbookDraftsResult>;
  /** Save the employee's edit of an item: republished with the edited body (sanitized). */
  publish(key: string, edited: HandbookDraftBody, keepShots: number[]): Promise<void>;
  /** Hide a published item: withdrawn now and not republished until its source changes. */
  hide(key: string): Promise<void>;
  /** Show a hidden item again: published on the spot when possible, otherwise on the next sync. */
  unhide(key: string): Promise<void>;
  withdraw(itemId: string): Promise<void>;
  /** Publish every new or changed item. Silent on failure; returns how many items were published. */
  syncPublish(): Promise<number>;
  /** Fire-and-forget sync (after a teach save, a restored login...). */
  requestSync(): void;
  withdrawLearnItems(): Promise<void>;
  /** Retry a pending learn-items withdrawal now (no-op when none is pending). */
  retryPendingWithdraw(): Promise<void>;
  /** Sync now and every `intervalMs`: retry a pending withdrawal, then auto-publish. Returns a stop function. */
  startSync(intervalMs?: number): () => void;
  mine(): Promise<HandbookView>;
  media(id: string): Promise<string>;
  draftShot(key: string, shot: number): Promise<string>;
  preview(body: HandbookActivityBody): string;
  adminRoles(): Promise<HandbookRoleSummary[]>;
  adminRole(key: string): Promise<HandbookView>;
  roles(): Promise<HandbookRoleSummary[]>;
  role(key: string): Promise<HandbookView>;
};

type SourceDraft = Omit<HandbookDraft, 'hash' | 'publishedItemId' | 'status'> & { shotsDir: string | null };

/** Stable identity of a source: edits and hiding follow it, not the content that drifts between batches. */
const identityOf = (source: Pick<SourceDraft, 'key' | 'kind' | 'source' | 'body' | 'shots'>): string => {
  if (source.source === 'taught') return draftHash(source.body, source.shots);
  return draftHash(
    { id: source.kind === 'indicators' ? (source.body as HandbookIndicatorsBody).weekStart : source.key },
    []
  );
};
const contentOf = (source: Pick<SourceDraft, 'body' | 'shots'>): string => draftHash(source.body, source.shots);

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
/** Trim, scrub secrets and personal identifiers (see scrub.ts), then cap the length. */
const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? scrubText(value.trim()).slice(0, max) : '';
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
    ...(source.lessons?.length ? { lessons: source.lessons.map((lesson) => clip(lesson, 2000)).filter(Boolean) } : {}),
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
          // A lesson store that cannot be read only leaves the lessons out, never the task.
          const stored = (await deps.lessonsFor?.(name).catch((): Lesson[] => [])) ?? [];
          const lessons = stored.map((lesson) => lesson.text);
          if (lessons.length > 0) body.lessons = lessons;
          return { key: `taught:${name}`, kind: 'activity', source: 'taught', body, shots: used, shotsDir: dir };
        } catch {
          return null;
        }
      })
    );
    return drafts.filter((draft): draft is SourceDraft => draft !== null);
  };

  const learnDrafts = async (): Promise<SourceDraft[]> => {
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

  let retrying: Promise<void> | null = null;
  let syncing: Promise<number> | null = null;

  const retryPendingWithdraw = (): Promise<void> => {
    if (retrying) return retrying;
    retrying = (async () => {
      const state = await loadState();
      if (!state.pendingWithdrawLearn) return;
      try {
        await deps.client.withdrawLearn();
      } catch {
        // Still offline, blocked or outside hours: the next sync tries again.
        return;
      }
      await updateState(clearLearnLocal);
    })().finally(() => {
      retrying = null;
    });
    return retrying;
  };

  const findSource = async (key: string): Promise<SourceDraft> => {
    const source = (await sources()).find((draft) => draft.key === key);
    if (!source) throw new Error('not_found');
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

  const titleOf = (source: Pick<SourceDraft, 'kind' | 'body'>): string =>
    source.kind === 'activity'
      ? (source.body as HandbookActivityBody).title
      : (source.body as HandbookIndicatorsBody).weekStart;

  /**
   * Send one item to the company server. Nothing is stored locally unless the server accepted
   * it (no_role, offline...). `keepShots` are the screenshots that go along.
   */
  const publishSource = async (
    source: SourceDraft,
    edited: unknown,
    keepShots: number[],
    remember: { edited: boolean }
  ): Promise<void> => {
    const state = await loadState();
    const itemId = state.published[source.key]?.itemId ?? randomUUID();
    const hash = identityOf(source);
    let body: object;
    const media: Array<{ id: string; base64: string }> = [];
    let activity: HandbookActivityBody | null = null;
    if (source.kind === 'activity') {
      activity = sanitizeActivity(edited, source.body as HandbookActivityBody);
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
    } else {
      body = sanitizeIndicators(edited, source.body as HandbookIndicatorsBody);
    }
    await deps.client.publish({ id: itemId, kind: source.kind, source: source.source, body, media });
    const entry: PublishedEntry = {
      itemId,
      hash,
      contentHash: contentOf(source),
      kind: source.kind,
      source: source.source,
      title: titleOf(source),
    };
    if (remember.edited && activity) {
      entry.edited = activity;
      entry.keepShots = [...keepShots];
    }
    await updateState((next) => {
      next.published[source.key] = entry;
      delete next.dismissed[source.key];
      if (next.failed) delete next.failed[source.key];
    });
  };

  const runSync = async (notify: boolean): Promise<number> => {
    let count = 0;
    try {
      for (const source of await sources()) {
        // State is re-read per item: a hide or an edit made meanwhile wins over this sync.
        // eslint-disable-next-line no-await-in-loop
        const state = await loadState();
        if (source.source === 'learn' && state.pendingWithdrawLearn) continue;
        const identity = identityOf(source);
        const content = contentOf(source);
        const entry = state.published[source.key];
        if (state.dismissed[source.key] === identity) continue;
        if (state.failed?.[source.key]?.hash === content) continue;
        const isNew = entry?.hash !== identity;
        // Same identity: only an unedited observed item refreshes (silently); an edit is never overwritten.
        if (!isNew && (entry.contentHash === content || entry.edited)) continue;
        try {
          // The employee's edit survives a source change; only lessons, skill name and screenshots come from the source.
          // eslint-disable-next-line no-await-in-loop -- one upload at a time
          await (isNew && entry?.edited
            ? publishSource(source, entry.edited, entry.keepShots ?? source.shots, { edited: true })
            : publishSource(source, source.body, source.shots, { edited: false }));
          if (isNew) count += 1;
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).trim();
          // Offline / no role / no permission: stop and retry next sync.
          if (STOP_SYNC_RE.test(message)) break;
          // Anything else is permanent for this content: skip it until the source changes.
          // eslint-disable-next-line no-await-in-loop
          await updateState((next) => {
            next.failed = { ...next.failed, [source.key]: { hash: content, failedAt: now() } };
          }).catch(() => {});
        }
      }
    } catch {
      // A sync never throws: whatever is left is retried next time.
    }
    if (count > 0 && notify) deps.onPublished?.(count);
    return count;
  };

  const syncPublish = (notify = true): Promise<number> => {
    if (syncing) return syncing;
    syncing = runSync(notify).finally(() => {
      syncing = null;
    });
    return syncing;
  };

  let syncTimer: ReturnType<typeof setInterval> | null = null;

  return {
    async drafts() {
      await retryPendingWithdraw();
      const state = await loadState();
      let role = state.role ?? null;
      try {
        role = (await deps.client.mine()).role;
        if (JSON.stringify(role) !== JSON.stringify(state.role ?? null)) {
          await updateState((next) => {
            next.role = role;
          });
        }
      } catch (error) {
        // Offline: the Manual still opens from local state once a role was seen.
        if (!state.role) throw error;
      }
      const bySource = new Map((await sources()).map((source) => [source.key, source]));
      const published: HandbookPublished[] = Object.entries(state.published).map(([key, entry]) => {
        const source = bySource.get(key);
        const hash = source ? identityOf(source) : entry.hash;
        const { shotsDir: _dir, ...rest } = source ?? ({} as SourceDraft);
        const edited = entry.edited ?? null;
        return {
          key,
          itemId: entry.itemId,
          kind: entry.kind,
          title: entry.title,
          draft: source ? { ...rest, body: edited ?? source.body, hash, publishedItemId: entry.itemId } : null,
        };
      });
      const hidden: HandbookHidden[] = [];
      for (const [key, hiddenHash] of Object.entries(state.dismissed)) {
        const source = bySource.get(key);
        if (source && identityOf(source) === hiddenHash) {
          hidden.push({ key, kind: source.kind, title: titleOf(source) });
        }
      }
      return { role, published, hidden };
    },

    async publish(key, edited, keepShots) {
      const source = await findSource(key);
      await publishSource(source, edited, keepShots, { edited: true });
    },

    async hide(key) {
      const state = await loadState();
      const entry = state.published[key];
      const source = (await sources()).find((draft) => draft.key === key);
      if (!entry && !source) return;
      const hash = source ? identityOf(source) : (entry?.hash ?? '');
      if (entry) await deps.client.remove(entry.itemId);
      await updateState((next) => {
        delete next.published[key];
        next.dismissed[key] = hash;
      });
    },

    async unhide(key) {
      await updateState((state) => {
        delete state.dismissed[key];
      });
      // Not announced: the employee just asked for it. An offline failure is retried next sync.
      await syncPublish(false);
    },

    async withdraw(itemId) {
      // Withdrawing a known item is hiding it, so the next sync does not publish it again.
      const state = await loadState();
      const key = Object.entries(state.published).find(([, entry]) => entry.itemId === itemId)?.[0];
      if (key) return this.hide(key);
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
        throw error;
      }
      await updateState(clearLearnLocal);
    },

    retryPendingWithdraw: () => retryPendingWithdraw(),

    syncPublish: () => syncPublish(),

    requestSync() {
      void syncPublish();
    },

    startSync(intervalMs = SYNC_INTERVAL_MS) {
      const tick = () => {
        void retryPendingWithdraw()
          .catch(() => {})
          .then(() => syncPublish());
      };
      tick();
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = setInterval(tick, intervalMs);
      syncTimer.unref?.();
      return () => {
        if (syncTimer) clearInterval(syncTimer);
        syncTimer = null;
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

    roles: () => deps.client.roles(),

    async role(key) {
      return withFlowcharts(await deps.client.role(key));
    },
  };
}
