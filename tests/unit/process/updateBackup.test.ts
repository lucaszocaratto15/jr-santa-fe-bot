import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupUserData, pruneBackups } from '@process/services/updateBackup';

const roots: string[] = [];

async function profile() {
  const root = await mkdtemp(path.join(tmpdir(), 'jr-update-backup-'));
  roots.push(root);
  const userData = path.join(root, 'userData');
  for (const dir of ['aionui', 'config', 'jr-vault', 'Cache', 'logs', path.join('jr-workspaces', 'w1')]) {
    await mkdir(path.join(userData, dir), { recursive: true });
  }
  await writeFile(path.join(userData, 'aionui', 'aionui.db'), 'db-bytes');
  await writeFile(path.join(userData, 'config', 'settings.json'), '{}');
  await writeFile(path.join(userData, 'jr-vault', 'item.bin'), 'secret');
  await writeFile(path.join(userData, 'Cache', 'big.bin'), 'x'.repeat(1_000));
  await writeFile(path.join(userData, 'logs', 'app.log'), 'log');
  await writeFile(path.join(userData, 'jr-workspaces', 'w1', 'file.txt'), 'ctx');
  return userData;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('backupUserData', () => {
  it('copies the profile and skips caches and logs', async () => {
    const userData = await profile();
    const target = await backupUserData({
      userData,
      version: '9.9.9',
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });
    expect(target).toBeTruthy();

    await expect(stat(path.join(target as string, 'aionui', 'aionui.db'))).resolves.toBeTruthy();
    await expect(stat(path.join(target as string, 'config', 'settings.json'))).resolves.toBeTruthy();
    await expect(stat(path.join(target as string, 'jr-vault', 'item.bin'))).resolves.toBeTruthy();
    await expect(stat(path.join(target as string, 'jr-workspaces', 'w1', 'file.txt'))).resolves.toBeTruthy();
    await expect(stat(path.join(target as string, 'Cache'))).rejects.toThrow();
    await expect(stat(path.join(target as string, 'logs'))).rejects.toThrow();
  });

  it('keeps only the newest backups', async () => {
    const userData = await profile();
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) {
      await backupUserData({ userData, version: '1.0.0', keep: 2, now: () => new Date(`${day}T00:00:00.000Z`) });
    }
    const root = path.join(userData, 'jr-update-backups');
    const kept = (await readdir(root)).sort();
    expect(kept).toHaveLength(2);
    expect(kept[0]).toContain('2026-01-03');
    expect(kept[1]).toContain('2026-01-04');
  });

  it('respects the byte budget and still copies the database first', async () => {
    const userData = await profile();
    const target = await backupUserData({
      userData,
      version: '1.0.0',
      maxBytes: 10,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });
    expect(target).toBeTruthy();
    await expect(stat(path.join(target as string, 'aionui', 'aionui.db'))).resolves.toBeTruthy();
    await expect(stat(path.join(target as string, 'jr-vault'))).rejects.toThrow();
  });
});

describe('pruneBackups', () => {
  it('removes the oldest directories and keeps the requested count', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jr-prune-'));
    roots.push(root);
    for (const name of ['1.0.0-2026-01-01', '1.0.0-2026-01-02', '1.0.0-2026-01-03']) {
      await mkdir(path.join(root, name));
    }
    await pruneBackups(root, 2);
    expect((await readdir(root)).sort()).toEqual(['1.0.0-2026-01-02', '1.0.0-2026-01-03']);
  });
});
