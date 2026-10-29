/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LearnInsightBatch, LearnSample } from '@/common/types/agent/learnTypes';
import type { OsEncryption } from '@process/services/jr/auth';

export const RAW_RETENTION_MS = 48 * 3_600_000;
export const INSIGHT_RETENTION_MS = 90 * 86_400_000;
const HOUR_MS = 3_600_000;
const HOUR_FILE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2})\.log$/;

export type SampleStore = {
  append(sample: LearnSample): Promise<void>;
  /** Samples at or after `sinceMs`; with `nowMs`, never one older than the 48 h retention. */
  readSince(sinceMs: number, nowMs?: number): Promise<LearnSample[]>;
  count(sinceMs: number, nowMs?: number): Promise<number>;
  hours(): Promise<number>;
  purge(nowMs: number): Promise<void>;
  wipe(): Promise<void>;
};

export type InsightStore = {
  list(): Promise<LearnInsightBatch[]>;
  add(batch: LearnInsightBatch): Promise<void>;
  remove(id: string): Promise<void>;
  purge(nowMs: number): Promise<void>;
  wipe(): Promise<void>;
};

/** True only when the OS keychain backs `safeStorage`; `basic_text` counts as unavailable. */
export function encryptionUsable(encryption: OsEncryption): boolean {
  try {
    return encryption.isEncryptionAvailable() && encryption.getSelectedStorageBackend?.() !== 'basic_text';
  } catch {
    return false;
  }
}

function requireEncryption(encryption: OsEncryption): void {
  if (!encryptionUsable(encryption)) throw new Error('LEARN_ENCRYPTION_UNAVAILABLE');
}

/** Create `dir` (and parents) as a private, non-symlinked directory. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('LEARN_STORAGE_INVALID');
  if (process.platform !== 'win32') await chmod(dir, 0o700);
}

/** Atomic private write: tmp file (0o600) then rename. */
export async function writePrivateFile(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

const hourKey = (t: number): string => new Date(t).toISOString().slice(0, 13);
const hourStart = (key: string): number => Date.parse(`${key}:00:00.000Z`);

function validSample(value: unknown): value is LearnSample {
  if (!value || typeof value !== 'object') return false;
  const sample = value as Record<string, unknown>;
  return (
    typeof sample.t === 'number' &&
    Number.isFinite(sample.t) &&
    typeof sample.app === 'string' &&
    (sample.title === null || typeof sample.title === 'string') &&
    (sample.url === undefined || typeof sample.url === 'string')
  );
}

/** Encrypted hourly sample log: `samples/<YYYY-MM-DDTHH>.log` (UTC), one encrypted line per sample. */
export function createSampleStore(root: string, encryption: OsEncryption): SampleStore {
  const dir = join(root, 'samples');

  const hourFiles = async (): Promise<Array<{ file: string; start: number }>> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return names
      .map((name) => HOUR_FILE_RE.exec(name))
      .filter((match): match is RegExpExecArray => match !== null && !Number.isNaN(hourStart(match[1])))
      .map((match) => ({ file: join(dir, match[0]), start: hourStart(match[1]) }))
      .toSorted((a, b) => a.start - b.start);
  };

  const decodeLine = (line: string): LearnSample | null => {
    try {
      const value: unknown = JSON.parse(encryption.decryptString(Buffer.from(line, 'base64')));
      return validSample(value) ? value : null;
    } catch {
      return null;
    }
  };

  const readSince = async (requestedSince: number, nowMs?: number): Promise<LearnSample[]> => {
    if (!encryptionUsable(encryption)) return [];
    const sinceMs = nowMs === undefined ? requestedSince : Math.max(requestedSince, nowMs - RAW_RETENTION_MS);
    const files = (await hourFiles()).filter(({ start }) => start + HOUR_MS > sinceMs);
    const contents = await Promise.all(files.map(({ file }) => readFile(file, 'utf8').catch(() => '')));
    return contents
      .flatMap((content) => content.split('\n'))
      .filter((line) => line.trim() !== '')
      .map(decodeLine)
      .filter((sample): sample is LearnSample => sample !== null && sample.t >= sinceMs)
      .toSorted((a, b) => a.t - b.t);
  };

  return {
    async append(sample) {
      requireEncryption(encryption);
      const payload: LearnSample = { t: sample.t, app: sample.app, title: sample.title };
      if (sample.url) payload.url = sample.url;
      const line = encryption.encryptString(JSON.stringify(payload)).toString('base64');
      await ensurePrivateDir(root);
      await ensurePrivateDir(dir);
      await appendFile(join(dir, `${hourKey(sample.t)}.log`), `${line}\n`, { mode: 0o600 });
    },
    readSince,
    async count(sinceMs, nowMs) {
      return (await readSince(sinceMs, nowMs)).length;
    },
    async hours() {
      return (await hourFiles()).length;
    },
    async purge(nowMs) {
      // A file holds up to an hour of samples: drop it once its first sample is 47 h old, so with
      // up to an hour between purges no sample outlives the 48 h promise.
      const expired = (await hourFiles()).filter(({ start }) => nowMs - start >= RAW_RETENTION_MS - HOUR_MS);
      await Promise.all(expired.map(({ file }) => rm(file, { force: true })));
    },
    async wipe() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function validBatch(value: unknown): value is LearnInsightBatch {
  if (!value || typeof value !== 'object') return false;
  const batch = value as Record<string, unknown>;
  return (
    typeof batch.id === 'string' &&
    typeof batch.createdAt === 'number' &&
    Array.isArray(batch.timePerApp) &&
    Array.isArray(batch.repetitive) &&
    Array.isArray(batch.suggestions)
  );
}

/** Encrypted insight batches in `insights.bin`, newest first. */
export function createInsightStore(root: string, encryption: OsEncryption): InsightStore {
  const file = join(root, 'insights.bin');
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => {}).then(operation);
    queue = next;
    return next;
  };

  const read = async (): Promise<LearnInsightBatch[]> => {
    if (!encryptionUsable(encryption)) return [];
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    try {
      const value: unknown = JSON.parse(encryption.decryptString(Buffer.from(raw.trim(), 'base64')));
      return Array.isArray(value) ? value.filter(validBatch) : [];
    } catch {
      return [];
    }
  };

  const save = async (batches: LearnInsightBatch[]): Promise<void> => {
    requireEncryption(encryption);
    await ensurePrivateDir(root);
    const sorted = batches.toSorted((a, b) => b.createdAt - a.createdAt);
    await writePrivateFile(file, encryption.encryptString(JSON.stringify(sorted)).toString('base64'));
  };

  return {
    list: () => serialize(read),
    add: (batch) => serialize(async () => save([batch, ...(await read()).filter((b) => b.id !== batch.id)])),
    remove: (id) =>
      serialize(async () => {
        const batches = await read();
        if (batches.some((b) => b.id === id)) await save(batches.filter((b) => b.id !== id));
      }),
    purge: (nowMs) =>
      serialize(async () => {
        const batches = await read();
        const kept = batches.filter((b) => nowMs - b.createdAt <= INSIGHT_RETENTION_MS);
        if (kept.length !== batches.length) await save(kept);
      }),
    wipe: () => serialize(() => rm(file, { force: true })),
  };
}
