import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLearnSettings, sanitizeExclusions } from '@/process/services/teach/learn/learnSettings';
import { DEFAULT_EXCLUSIONS } from '@/process/services/teach/learn/privacyFilter';

let root: string;
beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'learn-settings-')), 'jr-learn');
});
afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('learn settings', () => {
  it('defaults to no pause taken, with the default exclusions', async () => {
    const data = await createLearnSettings(root).read();
    expect(data.pauseDay).toBeNull();
    expect(data).not.toHaveProperty('enabled');
    expect(data.exclusions).toEqual([...DEFAULT_EXCLUSIONS]);
  });

  it('corrupt settings.json falls back to defaults', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'settings.json'), '{not json');
    expect((await createLearnSettings(root).read()).pauseDay).toBeNull();
  });

  it('drops invalid exclusions from the file', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        pauseDay: '2026-10-30',
        exclusions: [{ id: 'x', kind: 'bogus', pattern: 'a', builtin: false }, 7],
      })
    );
    const data = await createLearnSettings(root).read();
    expect(data.pauseDay).toBe('2026-10-30');
    expect(data.exclusions).toEqual([]);
  });

  it('write merges a patch and persists it', async () => {
    const settings = createLearnSettings(root);
    await settings.write({ pauseDay: '2026-10-30' });
    const again = await createLearnSettings(root).read();
    expect(again.pauseDay).toBe('2026-10-30');
    expect(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).pauseDay).toBe('2026-10-30');
  });

  it('a malformed pauseDay is ignored', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'settings.json'), JSON.stringify({ pauseDay: '2026-10-30T10:00:00Z' }));
    expect((await createLearnSettings(root).read()).pauseDay).toBeNull();
  });

  it('reading never creates the directory', async () => {
    const settings = createLearnSettings(root);
    await settings.read();
    await expect(readFile(join(root, 'settings.json'))).rejects.toThrow();
  });
});

describe('custom exclusion limits', () => {
  const rule = (id: string, pattern: string, builtin = false) => ({ id, kind: 'app' as const, pattern, builtin });

  it('drops custom patterns shorter than 3 characters after trimming', () => {
    const kept = sanitizeExclusions([rule('a', 'a'), rule('b', ' ab '), rule('c', ' abc ')]);
    expect(kept.map((r) => r.id)).toEqual(['c']);
    expect(kept[0].pattern).toBe('abc');
  });

  it('keeps at most 20 custom rules', () => {
    const many = Array.from({ length: 30 }, (_, i) => rule(`r${i}`, `rule${i}`));
    expect(sanitizeExclusions(many)).toHaveLength(20);
  });

  it('keeps the shipped defaults, and a self-declared builtin is still limited', () => {
    expect(sanitizeExclusions(DEFAULT_EXCLUSIONS)).toHaveLength(DEFAULT_EXCLUSIONS.length);
    expect(sanitizeExclusions([rule('fake', 'x', true)])).toEqual([]);
  });
});
