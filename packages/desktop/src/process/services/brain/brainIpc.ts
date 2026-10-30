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
import { BRAIN_DIRNAME, createBrainCapture, type BrainCapture } from './brainCapture';

type NoticeFile = { version: string | null; at: string | null; synced: boolean };

export type BrainService = {
  capture(input: BrainCaptureInput): Promise<void>;
  lastCaptured(conversationId: string): Promise<string | null>;
  consentState(): Promise<BrainNoticeState>;
  accept(termVersion: string): Promise<BrainNoticeState>;
  search(query: string): Promise<BrainFact[]>;
  feedback(factId: string, reason?: string): Promise<{ suspended: boolean }>;
  me(): Promise<BrainMe>;
  /** Sends what is queued and any acknowledgement the server has not received yet. */
  resume(): Promise<void>;
  /** Ties the persisted queue to the logged-in profile. */
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
  const capture: BrainCapture = createBrainCapture({
    dir: deps.dir,
    send: (payload) => deps.client.capture(payload),
    secrets: deps.secrets,
    now,
    requireBoundProfile: true,
  });

  const readNotice = async (): Promise<NoticeFile> => {
    try {
      const data = JSON.parse(await readFile(noticeFile, 'utf8')) as Partial<NoticeFile>;
      return {
        version: typeof data.version === 'string' ? data.version : null,
        at: typeof data.at === 'string' ? data.at : null,
        synced: data.synced === true,
      };
    } catch {
      return { version: null, at: null, synced: false };
    }
  };

  const writeNotice = async (data: NoticeFile): Promise<void> => {
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

  const toState = (data: NoticeFile): BrainNoticeState => ({
    acknowledgedVersion: data.version,
    acknowledgedAt: data.at,
    current: data.version === BRAIN_TERM_VERSION,
  });

  const syncNotice = async (data: NoticeFile): Promise<void> => {
    if (!data.version || data.synced) return;
    try {
      await deps.client.consent(data.version);
      await writeNotice({ ...data, synced: true });
    } catch {
      // The server is unreachable: the local acknowledgement stands and is resent on resume.
    }
  };

  return {
    capture: (input) => capture.submit(input),
    lastCaptured: (conversationId) => capture.lastCaptured(conversationId),
    async consentState() {
      return toState(await readNotice());
    },
    async accept(termVersion) {
      // Acknowledgement only: capture and Aprender never wait for it.
      const data: NoticeFile = { version: termVersion, at: new Date(now()).toISOString(), synced: false };
      await writeNotice(data);
      await syncNotice(data);
      return toState(data);
    },
    search: (query) => deps.client.search(query),
    feedback: (factId, reason) => deps.client.feedback(factId, reason),
    me: () => deps.client.me(),
    bindProfile: (userId) => capture.bindProfile(userId),
    async resume() {
      await syncNotice(await readNotice());
      await capture.flush();
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
  // No flush here: the queue is resumed after the first bindProfile (login).
  return service;
}

/** A restored login resends the queue and a pending acknowledgement right away. */
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
}
