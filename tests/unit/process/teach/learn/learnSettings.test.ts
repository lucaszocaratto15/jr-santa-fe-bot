import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLearnSettings, latestAccept, type ConsentEvent } from '@/process/services/teach/learn/learnSettings';
import { DEFAULT_EXCLUSIONS } from '@/process/services/teach/learn/privacyFilter';

let root: string;
beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'learn-settings-')), 'jr-learn');
});
afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

const accept = (termVersion: string, at = '2026-10-29T15:02:00.000Z'): ConsentEvent => ({
  type: 'accept',
  termVersion,
  at,
  user: { id: 'u1', name: 'Ana' },
});

describe('learn settings', () => {
  it('defaults to disabled with the default exclusions', async () => {
    const data = await createLearnSettings(root).read();
    expect(data.enabled).toBe(false);
    expect(data.paused).toBe(false);
    expect(data.pausedUntil).toBeNull();
    expect(data.exclusions).toEqual([...DEFAULT_EXCLUSIONS]);
  });

  it('corrupt settings.json falls back to defaults', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'settings.json'), '{not json');
    expect((await createLearnSettings(root).read()).enabled).toBe(false);
  });

  it('drops invalid exclusions from the file', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({ enabled: true, exclusions: [{ id: 'x', kind: 'bogus', pattern: 'a', builtin: false }, 7] })
    );
    const data = await createLearnSettings(root).read();
    expect(data.enabled).toBe(true);
    expect(data.exclusions).toEqual([]);
  });

  it('write merges a patch and persists it', async () => {
    const settings = createLearnSettings(root);
    await settings.write({ enabled: true, pausedUntil: 5 });
    const again = await createLearnSettings(root).read();
    expect(again.enabled).toBe(true);
    expect(again.pausedUntil).toBe(5);
    expect(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).enabled).toBe(true);
  });

  it('reading never creates the directory', async () => {
    const settings = createLearnSettings(root);
    await settings.read();
    await settings.consent();
    await expect(readFile(join(root, 'settings.json'))).rejects.toThrow();
  });
});

describe('consent log', () => {
  it('appendConsent keeps earlier events', async () => {
    const settings = createLearnSettings(root);
    await settings.appendConsent(accept('1.1'));
    await settings.appendConsent(accept('1.2'));
    expect((await settings.consent()).map((e) => e.termVersion)).toEqual(['1.1', '1.2']);
  });

  it('latestAccept is null after a revoke', () => {
    const revoke: ConsentEvent = { type: 'revoke', termVersion: '1.2', at: '2026-10-30T00:00:00.000Z', user: null };
    expect(latestAccept([accept('1.2'), revoke])).toBeNull();
  });

  it('latestAccept returns the last accept', () => {
    expect(latestAccept([accept('1.1'), accept('1.2')])?.termVersion).toBe('1.2');
    expect(latestAccept([])).toBeNull();
  });

  it('a corrupt consent file reads as no events', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'consent.json'), '[]]');
    expect(await createLearnSettings(root).consent()).toEqual([]);
  });
});
