/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Silent capture of conversation stretches for the company brain. Purpose: understand the work to
 * help the employee; never performance evaluation or time control. Capture never throws to the
 * renderer. Text is redacted of vault secrets before it is queued; the queue lives in
 * userData/jr-brain/queue.json (atomic writes, 200 items max, oldest dropped) and is retried with
 * backoff while the server is offline or answers 503.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrainCaptureInput, BrainCapturePayload } from '@/common/types/agent/brainTypes';
import { redactSecrets } from '@process/resources/builtinMcp/secretRedact';

export const BRAIN_DIRNAME = 'jr-brain';
export const MAX_QUEUE_ITEMS = 200;
const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TOOL_CHARS = 500;
/** Serialized payload cap; the oldest messages of a stretch go first. */
export const MAX_PAYLOAD_BYTES = 200_000;
const PERMANENT_STATUSES = new Set([400, 403, 404, 409, 413, 422]);
const PERMANENT_CODES = new Set(['JR_ACCESS_FORBIDDEN', 'JR_HANDBOOK_TOO_LARGE', 'JR_ACCESS_EMPLOYEE_REVOKED']);
const MAX_TRACKED_CONVERSATIONS = 500;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const DEFAULT_BOT = 'bot';

/** Permanent failures (the server will never accept this payload) are dropped; the rest are retried. */
export function isPermanentFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return PERMANENT_STATUSES.has(status);
  return error instanceof Error && PERMANENT_CODES.has(error.message);
}

type QueueItem = { id: string; payload: BrainCapturePayload; attempts: number };

export type BrainCaptureDeps = {
  dir: string;
  send: (payload: BrainCapturePayload) => Promise<void>;
  secrets: () => Promise<string[]>;
  now?: () => number;
  /** Nothing is sent until bindProfile ran once (the queue's owner is then known). */
  requireBoundProfile?: boolean;
  /** Replaceable in tests; the default timer never keeps the process alive. */
  schedule?: (run: () => void, ms: number) => void;
};

export type BrainCapture = {
  /** Redacts, queues and starts a send. Always resolves. */
  submit(input: BrainCaptureInput): Promise<void>;
  /** Id of the last message already sent for this conversation. */
  lastCaptured(conversationId: string): Promise<string | null>;
  /** Sends what is due now; resolves when the pass is over. */
  flush(): Promise<void>;
  pending(): Promise<number>;
  /**
   * The queue belongs to one logged-in profile: another user id empties it (and the markers), so
   * one employee's stretches are never sent under another's identity.
   */
  bindProfile(userId: string): Promise<void>;
};

const conversationRef = (conversationId: string): string =>
  createHash('sha256').update(conversationId).digest('hex').slice(0, 32);

const isItem = (value: unknown): value is QueueItem => {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  const payload = item.payload as Record<string, unknown> | undefined;
  return (
    typeof item.id === 'string' &&
    typeof item.attempts === 'number' &&
    typeof payload === 'object' &&
    payload !== null &&
    typeof payload.conversationRef === 'string' &&
    typeof payload.bot === 'string' &&
    Array.isArray(payload.messages)
  );
};

export function createBrainCapture(deps: BrainCaptureDeps): BrainCapture {
  const now = deps.now ?? Date.now;
  const queueFile = join(deps.dir, 'queue.json');
  const markersFile = join(deps.dir, 'captured.json');
  const profileFile = join(deps.dir, 'profile.json');
  let queue: QueueItem[] | null = null;
  let markers: Record<string, string> | null = null;
  let retryAt = 0;
  let timerSet = false;
  let flushing: Promise<void> | null = null;
  let bound = !deps.requireBoundProfile;
  let chain: Promise<unknown> = Promise.resolve();

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  };

  const writeAtomic = async (file: string, data: unknown): Promise<void> => {
    await mkdir(deps.dir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(data));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };

  const readJson = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      // Missing or corrupt: start empty. Capture is best effort.
      return null;
    }
  };

  const loadQueue = async (): Promise<QueueItem[]> => {
    if (queue) return queue;
    const data = (await readJson(queueFile)) as { items?: unknown } | null;
    queue = Array.isArray(data?.items) ? data.items.filter(isItem) : [];
    return queue;
  };

  const loadMarkers = async (): Promise<Record<string, string>> => {
    if (markers) return markers;
    const data = await readJson(markersFile);
    markers = {};
    if (typeof data === 'object' && data !== null) {
      for (const [key, value] of Object.entries(data)) if (typeof value === 'string') markers[key] = value;
    }
    return markers;
  };

  const saveQueue = (items: QueueItem[]) => writeAtomic(queueFile, { version: 1, items });

  const arm = (ms: number): void => {
    if (timerSet) return;
    timerSet = true;
    const run = () => {
      timerSet = false;
      void capture.flush();
    };
    if (deps.schedule) deps.schedule(run, ms);
    else setTimeout(run, ms).unref?.();
  };

  const redactMessages = async (input: BrainCaptureInput): Promise<BrainCapturePayload['messages']> => {
    const secrets = await deps.secrets().catch((): string[] => []);
    // Redact the whole text first, then clip: a cut can never leave a prefix of a secret.
    const messages = input.messages
      .slice(-MAX_MESSAGES)
      .map((message) => ({
        role: message.role,
        text: redactSecrets(message.text, secrets).slice(
          0,
          message.role === 'tool' ? MAX_TOOL_CHARS : MAX_MESSAGE_CHARS
        ),
      }))
      .filter((message) => message.text.trim().length > 0);
    return messages;
  };

  const runFlush = async (): Promise<void> => {
    if (now() < retryAt) {
      arm(retryAt - now());
      return;
    }
    for (;;) {
      const head = await serialize(async () => (await loadQueue())[0] ?? null);
      if (!head) return;
      try {
        await deps.send(head.payload);
      } catch (error) {
        if (isPermanentFailure(error)) {
          // The server will never take this one: drop it and go on with the next.
          await serialize(async () => {
            const items = await loadQueue();
            const index = items.findIndex((item) => item.id === head.id);
            if (index !== -1) items.splice(index, 1);
            await saveQueue(items).catch(() => {});
          });
          continue;
        }
        // Offline, 401, 408, 429, 5xx: the item stays; back off and try again later.
        const attempts = head.attempts + 1;
        const wait = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
        retryAt = now() + wait;
        await serialize(async () => {
          const items = await loadQueue();
          const current = items.find((item) => item.id === head.id);
          if (current) {
            current.attempts = attempts;
            await saveQueue(items).catch(() => {});
          }
        });
        arm(wait);
        return;
      }
      retryAt = 0;
      await serialize(async () => {
        const items = await loadQueue();
        const index = items.findIndex((item) => item.id === head.id);
        if (index !== -1) items.splice(index, 1);
        await saveQueue(items).catch(() => {});
      });
    }
  };

  const capture: BrainCapture = {
    async submit(input) {
      try {
        const last = input.messages.at(-1);
        if (!last || !input.conversationId) return;
        const messages = await redactMessages(input);
        if (messages.length === 0) return;
        const payload: BrainCapturePayload = {
          conversationRef: conversationRef(input.conversationId),
          bot: DEFAULT_BOT,
          messages,
        };
        // Bytes of the whole serialized payload (multibyte text counts), oldest messages first out.
        while (messages.length > 1 && Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) messages.shift();
        const item: QueueItem = { id: randomUUID(), payload, attempts: 0 };
        await serialize(async () => {
          const items = await loadQueue();
          items.push(item);
          // Oldest first out when the cap is exceeded.
          while (items.length > MAX_QUEUE_ITEMS) items.shift();
          await saveQueue(items);
          const known = await loadMarkers();
          known[input.conversationId] = last.id;
          const keys = Object.keys(known);
          for (const key of keys.slice(0, Math.max(0, keys.length - MAX_TRACKED_CONVERSATIONS))) delete known[key];
          await writeAtomic(markersFile, known);
        });
        void capture.flush();
      } catch {
        // Silent by design: a capture problem is never shown to the employee.
      }
    },

    async lastCaptured(conversationId) {
      try {
        return (await serialize(loadMarkers))[conversationId] ?? null;
      } catch {
        return null;
      }
    },

    flush() {
      if (!bound) return Promise.resolve();
      flushing ??= runFlush()
        .catch(() => {})
        .finally(() => {
          flushing = null;
        });
      return flushing;
    },

    async bindProfile(userId) {
      try {
        await serialize(async () => {
          const stored = (await readJson(profileFile)) as { userId?: unknown } | null;
          // No profile.json: the owner of any existing queue is unknown, so it is cleared too.
          if (stored?.userId !== userId) {
            queue = [];
            markers = {};
            await saveQueue(queue);
            await writeAtomic(markersFile, markers);
          }
          if (stored?.userId !== userId) await writeAtomic(profileFile, { userId });
        });
        bound = true;
      } catch {
        // Best effort.
      }
    },

    async pending() {
      return (await serialize(loadQueue)).length;
    },
  };
  return capture;
}
