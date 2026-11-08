import { mkdtemp, readdir, readFile, rm, stat, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInsightStore, createSampleStore } from '@/process/services/teach/learn/sampleStore';
import type { LearnInsightBatch } from '@/common/types/agent/learnTypes';
import type { OsEncryption } from '@/process/services/jr/auth';

/** Reversible, non-identity "encryption" so plaintext checks are meaningful. */
const encryption: OsEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(text.split('').toReversed().join('')),
  decryptString: (buffer: Buffer) => buffer.toString().split('').toReversed().join(''),
};

const at = (iso: string) => Date.parse(iso);
const batch = (id: string, createdAt: number): LearnInsightBatch => ({
  id,
  createdAt,
  periodStart: createdAt - 1000,
  periodEnd: createdAt,
  timePerApp: [{ app: 'Excel', minutes: 3 }],
  repetitive: [{ title: 'Planilha NF', description: 'd', times: 2, minutes: 4 }],
  suggestions: [],
});

let root: string;
beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'learn-store-')), 'jr-learn');
});
afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

const readAllSampleBytes = async () => {
  const dir = join(root, 'samples');
  const files = await readdir(dir);
  const contents = await Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')));
  return contents.join('\n');
};

describe('sample store', () => {
  it('never writes a sample title in plaintext', async () => {
    const store = createSampleStore(root, encryption);
    await store.append({ t: at('2026-10-29T10:00:00Z'), app: 'Excel', title: 'Planilha NF' });
    const bytes = await readAllSampleBytes();
    expect(bytes).not.toContain('Planilha NF');
    expect(bytes).not.toContain('Excel');
  });

  it('readSince returns samples in time order across hour files', async () => {
    const store = createSampleStore(root, encryption);
    await store.append({ t: at('2026-10-29T11:05:00Z'), app: 'B', title: null });
    await store.append({ t: at('2026-10-29T10:59:00Z'), app: 'A', title: 'x' });
    await store.append({ t: at('2026-10-29T12:00:00Z'), app: 'C', title: null, url: 'https://a.com/p' });
    const all = await store.readSince(0);
    expect(all.map((s) => s.app)).toEqual(['A', 'B', 'C']);
    expect(await store.readSince(at('2026-10-29T11:00:00Z'))).toHaveLength(2);
    expect(await store.count(0)).toBe(3);
    expect(await store.hours()).toBe(3);
  });

  it('purge deletes hour files that started 47 h ago or more and keeps the current hour', async () => {
    const store = createSampleStore(root, encryption);
    await store.append({ t: at('2026-10-29T09:30:00Z'), app: 'old', title: null });
    await store.append({ t: at('2026-10-29T11:30:00Z'), app: 'old too', title: null });
    await store.append({ t: at('2026-10-29T12:30:00Z'), app: 'kept', title: null });
    await store.append({ t: at('2026-10-31T10:10:00Z'), app: 'now', title: null });
    await store.purge(at('2026-10-31T10:30:00Z'));
    const files = await readdir(join(root, 'samples'));
    expect(files.toSorted()).toEqual(['2026-10-29T12.log', '2026-10-31T10.log']);
  });

  it('a sample at the start of an hour is gone by 48 h even with an hour of purge delay', async () => {
    const store = createSampleStore(root, encryption);
    const t = at('2026-10-29T10:00:00Z');
    await store.append({ t, app: 'edge', title: null });
    await store.purge(t + 47 * 3_600_000 - 1);
    expect(await store.readSince(0)).toHaveLength(1);
    await store.purge(t + 47 * 3_600_000);
    expect(await store.readSince(0)).toEqual([]);
  });

  it('readSince never returns a sample older than 48 h, even before a purge', async () => {
    const store = createSampleStore(root, encryption);
    const now = at('2026-10-31T10:30:00Z');
    await store.append({ t: now - 48 * 3_600_000 - 1, app: 'stale', title: null });
    await store.append({ t: now - 60_000, app: 'fresh', title: null });
    expect((await store.readSince(0, now)).map((s) => s.app)).toEqual(['fresh']);
  });

  it('purge with no samples dir does not create it', async () => {
    const store = createSampleStore(root, encryption);
    await store.purge(Date.now());
    await expect(stat(join(root, 'samples'))).rejects.toThrow();
  });

  it('wipe removes the samples dir', async () => {
    const store = createSampleStore(root, encryption);
    await store.append({ t: Date.now(), app: 'A', title: null });
    await store.wipe();
    await expect(stat(join(root, 'samples'))).rejects.toThrow();
    expect(await store.readSince(0)).toEqual([]);
  });

  it('skips a corrupted line instead of failing the read', async () => {
    const store = createSampleStore(root, encryption);
    const t = at('2026-10-29T10:00:00Z');
    await store.append({ t, app: 'A', title: null });
    await appendFile(join(root, 'samples', '2026-10-29T10.log'), 'not-base64-json\n');
    await store.append({ t: t + 1000, app: 'B', title: null });
    expect((await store.readSince(0)).map((s) => s.app)).toEqual(['A', 'B']);
  });

  it('refuses to write when encryption is unavailable', async () => {
    const store = createSampleStore(root, { ...encryption, getSelectedStorageBackend: () => 'basic_text' });
    await expect(store.append({ t: Date.now(), app: 'A', title: 'secret' })).rejects.toThrow(
      'LEARN_ENCRYPTION_UNAVAILABLE'
    );
    await expect(stat(join(root, 'samples'))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('files are 0o600 and the root dir 0o700', async () => {
    const store = createSampleStore(root, encryption);
    await store.append({ t: at('2026-10-29T10:00:00Z'), app: 'A', title: null });
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, 'samples'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, 'samples', '2026-10-29T10.log'))).mode & 0o777).toBe(0o600);
  });
});

describe('insight store', () => {
  it('lists newest first and removes by id', async () => {
    const store = createInsightStore(root, encryption);
    await store.add(batch('a', 1000));
    await store.add(batch('b', 2000));
    expect((await store.list()).map((b) => b.id)).toEqual(['b', 'a']);
    await store.remove('b');
    expect((await store.list()).map((b) => b.id)).toEqual(['a']);
  });

  it('insight store purges batches older than 90 days', async () => {
    const store = createInsightStore(root, encryption);
    const now = at('2026-10-29T00:00:00Z');
    await store.add(batch('old', now - 91 * 86_400_000));
    await store.add(batch('new', now - 89 * 86_400_000));
    await store.purge(now);
    expect((await store.list()).map((b) => b.id)).toEqual(['new']);
  });

  it('insights file is not plaintext', async () => {
    const store = createInsightStore(root, encryption);
    await store.add(batch('a', 1000));
    const bytes = await readFile(join(root, 'insights.bin'), 'utf8');
    expect(bytes).not.toContain('Planilha NF');
  });

  it('a corrupt insights file reads as empty', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'insights.bin'), 'garbage');
    expect(await createInsightStore(root, encryption).list()).toEqual([]);
  });

  it('wipe deletes the insights file', async () => {
    const store = createInsightStore(root, encryption);
    await store.add(batch('a', 1000));
    await store.wipe();
    await expect(stat(join(root, 'insights.bin'))).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('insights file is 0o600', async () => {
    const store = createInsightStore(root, encryption);
    await store.add(batch('a', 1000));
    expect((await stat(join(root, 'insights.bin'))).mode & 0o777).toBe(0o600);
  });
});
