/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ipcBridge } from '@/common';
import {
  BRAIN_TERM_VERSION,
  type BrainCaptureInput,
  type BrainFact,
  type BrainMe,
  type BrainNoticeState,
} from '@/common/types/agent/brainTypes';
import { createBrainClient, type BrainCall, type BrainClient } from '@process/services/jr/brainClient';
import { vaultSecrets } from '../teach/lessons/lessonRuntime';
import { BRAIN_DIRNAME } from './brainCapture';
import { redactSecrets } from '@process/resources/builtinMcp/secretRedact';

type NoticeEntry = { version: string | null; at: string | null; synced: boolean };
/** notice.json: one acknowledgement per JR user id, so each employee on a shared PC sees the notice. */
type NoticeFile = Record<string, NoticeEntry>;

const EMPTY_NOTICE: NoticeEntry = { version: null, at: null, synced: false };

export type BrainService = {
  /** Legacy IPC compatibility only: passive capture is disabled. */
  capture(input: BrainCaptureInput): Promise<void>;
  lastCaptured(conversationId: string): Promise<string | null>;
  consentState(): Promise<BrainNoticeState>;
  accept(termVersion: string): Promise<BrainNoticeState>;
  search(query: string): Promise<BrainFact[]>;
  feedback(factId: string, reason?: string): Promise<{ suspended: boolean }>;
  me(): Promise<BrainMe>;
  manage: BrainClient['manage'];
  notes: BrainClient['notes'];
  /** Syncs only pending notice acknowledgements. The legacy conversation queue is quarantined. */
  resume(): Promise<void>;
  /** Selects the signed-in profile for notice acknowledgement only. */
  bindProfile(userId: string): Promise<void>;
};

export type BrainServiceDeps = {
  dir: string;
  client: BrainClient;
  secrets: () => Promise<string[]>;
  now?: () => number;
};

export function createBrainService(deps: BrainServiceDeps): BrainService {
  const now = deps.now ?? Date.now;
  const noticeFile = path.join(deps.dir, 'notice.json');
  // The legacy queue is quarantined in place: never read, replay, rewrite or delete it here.

  // Until a profile is bound nobody has acknowledged anything on this PC.
  let userId: string | null = null;

  const readAll = async (): Promise<NoticeFile> => {
    const all: NoticeFile = {};
    try {
      const data = JSON.parse(await readFile(noticeFile, 'utf8')) as unknown;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return all;
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        const entry = value as Partial<NoticeEntry>;
        all[key] = {
          version: typeof entry.version === 'string' ? entry.version : null,
          at: typeof entry.at === 'string' ? entry.at : null,
          synced: entry.synced === true,
        };
      }
    } catch {
      // Missing or corrupt: nobody has acknowledged.
    }
    return all;
  };

  const readNotice = async (user: string | null): Promise<NoticeEntry> =>
    user === null ? EMPTY_NOTICE : ((await readAll())[user] ?? EMPTY_NOTICE);

  const writeNotice = async (user: string, entry: NoticeEntry): Promise<void> => {
    const data = { ...(await readAll()), [user]: entry };
    await mkdir(deps.dir, { recursive: true, mode: 0o700 });
    const temporary = `${noticeFile}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(data));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, noticeFile);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };

  const toState = (data: NoticeEntry): BrainNoticeState => ({
    acknowledgedVersion: data.version,
    acknowledgedAt: data.at,
    current: data.version === BRAIN_TERM_VERSION,
  });

  const syncNotice = async (user: string | null, data: NoticeEntry): Promise<void> => {
    if (user === null || !data.version || data.synced) return;
    try {
      await deps.client.consent(data.version);
      await writeNotice(user, { ...data, synced: true });
    } catch {
      // The server is unreachable: the local acknowledgement stands and is resent on resume.
    }
  };

  return {
    capture: async () => {},
    lastCaptured: async () => null,
    async consentState() {
      return toState(await readNotice(userId));
    },
    async accept(termVersion) {
      // Acknowledgement is separate from the explicit consent of each note/version.
      const user = userId;
      if (user === null) throw new Error('unavailable');
      const data: NoticeEntry = { version: termVersion, at: new Date(now()).toISOString(), synced: false };
      await writeNotice(user, data);
      await syncNotice(user, data);
      return toState(data);
    },
    search: (query) => deps.client.search(query),
    feedback: (factId, reason) => deps.client.feedback(factId, reason),
    me: () => deps.client.me(),
    manage: deps.client.manage,
    notes: {
      ...deps.client.notes,
      async create(input) {
        if (input.factId !== undefined) {
          if (!Number.isInteger(input.factId) || input.factId < 1) throw new Error('invalid_note');
          return deps.client.notes.create({ requestId: randomUUID(), factId: input.factId });
        }
        if (typeof input.excerpt !== 'string' || !input.excerpt.trim() || input.excerpt.length > 4000)
          throw new Error('invalid_excerpt');
        if (input.sourceRole !== undefined && input.sourceRole !== 'user' && input.sourceRole !== 'assistant')
          throw new Error('invalid_source');
        const excerpt = redactSecrets(input.excerpt.trim(), await deps.secrets());
        return deps.client.notes.create({ requestId: randomUUID(), excerpt, sourceRole: input.sourceRole });
      },
    },
    async bindProfile(id) {
      userId = id;
    },
    async resume() {
      const user = userId;
      await syncNotice(user, await readNotice(user));
    },
  };
}

let service: BrainService | null = null;

/** Create and register the brain service over the JR access controller's `call`. */
export function startBrainService(userDataDir: string, call: BrainCall): BrainService {
  service = createBrainService({
    dir: path.join(userDataDir, BRAIN_DIRNAME),
    client: createBrainClient(call),
    secrets: vaultSecrets,
  });
  // Legacy queue files are intentionally untouched, including at login.
  return service;
}

/** The registered brain service; null without a JR access controller. */
export const getBrainService = (): BrainService | null => service;

/** A restored login syncs pending notice acknowledgement only. */
export function onBrainAccessChanged(status: string, userId?: string): void {
  if (status !== 'authenticated') return;
  void (async () => {
    if (userId) await service?.bindProfile(userId);
    await service?.resume();
  })().catch(() => {});
}

/** "Cérebro" IPC. Without a service (no JR access controller) capture is a silent no-op. */
export function initBrainBridge(): void {
  const required = (): BrainService => {
    if (!service) throw new Error('unavailable');
    return service;
  };
  ipcBridge.brain.consentState.provider(async () =>
    service ? service.consentState() : { acknowledgedVersion: null, acknowledgedAt: null, current: false }
  );
  ipcBridge.brain.accept.provider(async ({ termVersion }) => required().accept(termVersion));
  ipcBridge.brain.captureStretch.provider(async (input) => {
    try {
      await service?.capture(input);
    } catch {
      // Silent by design.
    }
  });
  ipcBridge.brain.lastCaptured.provider(async ({ conversationId }) =>
    service ? service.lastCaptured(conversationId) : null
  );
  ipcBridge.brain.search.provider(async ({ query }) => required().search(query));
  ipcBridge.brain.feedback.provider(async ({ factId, reason }) => required().feedback(factId, reason));
  ipcBridge.brain.me.provider(async () => required().me());
  ipcBridge.brain.notes.create.provider(async (input) => required().notes.create({ requestId: '', ...input }));
  ipcBridge.brain.notes.revise.provider(async (input) => required().notes.revise(input));
  ipcBridge.brain.notes.consent.provider(async (input) => required().notes.consent(input));
  ipcBridge.brain.notes.pending.provider(async () => required().notes.pending());
  ipcBridge.brain.notes.review.provider(async (input) => required().notes.review(input));
  const manage = ipcBridge.brain.manage;
  manage.facts.provider(async (filters) => required().manage.facts(filters));
  manage.updateFact.provider(async ({ id, patch }) => required().manage.updateFact(id, patch));
  manage.history.provider(async ({ id }) => required().manage.history(id));
  manage.areas.provider(async () => required().manage.areas());
  manage.createArea.provider(async ({ name }) => required().manage.createArea(name));
  manage.renameArea.provider(async ({ id, name }) => required().manage.renameArea(id, name));
  manage.removeArea.provider(async ({ id }) => required().manage.removeArea(id));
  manage.setMemberships.provider(async ({ userId, memberships }) =>
    required().manage.setMemberships(userId, memberships)
  );
  manage.deleteAuthorFacts.provider(async ({ userId }) => required().manage.deleteAuthorFacts(userId));
  manage.log.provider(async ({ since }) => required().manage.log(since));
}
