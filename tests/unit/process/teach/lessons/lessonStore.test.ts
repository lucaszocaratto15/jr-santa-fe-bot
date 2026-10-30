import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LessonProposal } from '@/common/types/agent/lessonTypes';
import { containsSecret, createLessonStore } from '@/process/services/teach/lessons/lessonStore';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const setup = async (secrets: string[] = []) => {
  const dir = await mkdtemp(join(tmpdir(), 'jr-lessons-'));
  roots.push(dir);
  let t = 1000;
  let n = 0;
  const make = () => createLessonStore(dir, { now: () => ++t, secrets: async () => secrets, newId: () => `id${++n}` });
  return { dir, store: make(), make };
};

const general = (text: string, extra: Partial<LessonProposal> = {}): LessonProposal => ({
  text,
  scope: { kind: 'general' },
  sourceQuote: 'q',
  ...extra,
});
const task = (text: string, skill = 'nfe'): LessonProposal => ({
  text,
  scope: { kind: 'task', skill },
  sourceQuote: 'q',
});

describe('lessonStore', () => {
  it('save creates an active lesson with no versions', async () => {
    const { store } = await setup();
    const l = await store.save(general('use datas dd/mm'), false);
    expect(l).toMatchObject({ id: 'id1', active: true, versions: [], text: 'use datas dd/mm' });
    expect(await store.list()).toHaveLength(1);
  });

  it('save with updateId pushes the old text and replaces it', async () => {
    const { store } = await setup();
    const l = await store.save(general('a'), false);
    const u = await store.save(general('b', { updateId: l.id }), true);
    expect(u.text).toBe('b');
    expect(u.versions.map((v) => v.text)).toEqual(['a']);
    expect(await store.list()).toHaveLength(1);
    expect(await store.counters()).toMatchObject({ saved: 2, edited: 1 });
  });

  it('update pushes a version; revert restores and pushes the current', async () => {
    const { store } = await setup();
    const l = await store.save(general('a'), false);
    await store.update(l.id, 'b');
    const r = await store.revert(l.id, 0);
    expect(r.text).toBe('a');
    expect(r.versions.map((v) => v.text)).toEqual(['a', 'b']);
  });

  it('setActive(false) keeps the lesson', async () => {
    const { store } = await setup();
    const l = await store.save(general('a'), false);
    const r = await store.setActive(l.id, false);
    expect(r.active).toBe(false);
    expect(await store.list()).toHaveLength(1);
  });

  it('limits active task lessons per skill', async () => {
    const { store } = await setup();
    for (let i = 0; i < 20; i++) await store.save(task(`t${i}`), false);
    await expect(store.save(task('x'), false)).rejects.toMatchObject({ code: 'limit_task' });
    await expect(store.save(task('y', 'other'), false)).resolves.toBeDefined();
  });

  it('limits active general lessons', async () => {
    const { store } = await setup();
    for (let i = 0; i < 30; i++) await store.save(general(`g${i}`), false);
    await expect(store.save(general('x'), false)).rejects.toMatchObject({ code: 'limit_general' });
  });

  it('rejects text over 200 chars (an unbroken long run counts as token-like)', async () => {
    const { store } = await setup();
    await expect(store.save(general('a'.repeat(201)), false)).rejects.toMatchObject({ code: 'too_long' });
    await expect(store.save(general('ab '.repeat(66).trim().padEnd(200, 'c')), false)).resolves.toBeDefined();
  });

  it('rejects vault secrets and CPF', async () => {
    const { store } = await setup(['hunter2pass']);
    await expect(store.save(general('senha é hunter2pass'), false)).rejects.toMatchObject({ code: 'secret' });
    await expect(store.save(general('cpf 123.456.789-09'), false)).rejects.toMatchObject({ code: 'secret' });
    await expect(store.update('nope', 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a bad scope', async () => {
    const { store } = await setup();
    await expect(store.save(task('a', ' '), false)).rejects.toMatchObject({ code: 'bad_scope' });
  });

  it('persists offered markers and counters across instances', async () => {
    const { store, make } = await setup();
    await store.markOffered('c1', 'm9');
    await store.bump('saved');
    const again = make();
    expect(await again.lastOffered('c1')).toBe('m9');
    expect(await again.lastOffered('zz')).toBeNull();
    expect((await again.counters()).saved).toBe(1);
  });

  it('moves a corrupt file aside and starts empty', async () => {
    const { dir, store } = await setup();
    await mkdir(join(dir, 'jr-lessons'), { recursive: true });
    await writeFile(join(dir, 'jr-lessons', 'lessons.json'), '{not json');
    expect(await store.list()).toEqual([]);
    const aside = (await readdir(join(dir, 'jr-lessons'))).filter((name) => name.startsWith('lessons.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(dir, 'jr-lessons', aside[0]), 'utf8')).toBe('{not json');
    await store.save(general('a'), false);
    const disk = JSON.parse(await readFile(join(dir, 'jr-lessons', 'lessons.json'), 'utf8'));
    expect(disk.lessons).toHaveLength(1);
  });

  it('moves a file of another version aside instead of overwriting it', async () => {
    const { dir, store } = await setup();
    await mkdir(join(dir, 'jr-lessons'), { recursive: true });
    await writeFile(join(dir, 'jr-lessons', 'lessons.json'), JSON.stringify({ version: 2, lessons: [] }));
    expect(await store.list()).toEqual([]);
    const names = await readdir(join(dir, 'jr-lessons'));
    expect(names.some((name) => name.startsWith('lessons.json.corrupt-'))).toBe(true);
  });

  it('a read error other than a missing file throws and does not overwrite', async () => {
    const { dir, store } = await setup();
    // A directory where the file should be: readFile fails with EISDIR (like EACCES/EBUSY).
    await mkdir(join(dir, 'jr-lessons', 'lessons.json'), { recursive: true });
    await expect(store.list()).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(store.save(general('a'), false)).rejects.toMatchObject({ code: 'EISDIR' });
    expect((await stat(join(dir, 'jr-lessons', 'lessons.json'))).isDirectory()).toBe(true);
  });

  it('saveMany stores nothing when one item of the batch is refused', async () => {
    const { store } = await setup();
    for (let i = 0; i < 19; i++) await store.save(task(`t${i}`), false);
    const before = await store.counters();
    await expect(
      store.saveMany([
        { proposal: task('cabe'), edited: false },
        { proposal: task('passa do limite'), edited: true },
      ])
    ).rejects.toMatchObject({ code: 'limit_task' });
    expect(await store.list()).toHaveLength(19);
    expect(await store.counters()).toEqual(before);
    const ok = await store.saveMany([
      { proposal: general('a'), edited: false },
      { proposal: general('b'), edited: true },
    ]);
    expect(ok.map((l) => l.text)).toEqual(['a', 'b']);
    expect(await store.counters()).toMatchObject({ saved: 21, edited: 1 });
  });

  it('collapses newlines and spaces in saved and updated text', async () => {
    const { store } = await setup();
    const l = await store.save(general('  confira\n## Passos\n  o total  '), false);
    expect(l.text).toBe('confira ## Passos o total');
    const u = await store.update(l.id, 'linha um\r\n\tlinha dois');
    expect(u.text).toBe('linha um linha dois');
  });

  it('revert refuses a version that now holds a vault secret', async () => {
    const secrets: string[] = [];
    const { store } = await setup(secrets);
    const l = await store.save(general('entre com hunter2xyz no portal'), false);
    await store.update(l.id, 'entre pelo portal');
    secrets.push('hunter2xyz');
    await expect(store.revert(l.id, 0)).rejects.toMatchObject({ code: 'secret' });
    expect((await store.list())[0].text).toBe('entre pelo portal');
  });

  it('serializes concurrent writes', async () => {
    const { store } = await setup();
    await Promise.all(Array.from({ length: 10 }, () => store.bump('offered')));
    expect((await store.counters()).offered).toBe(10);
  });
});

describe('containsSecret', () => {
  it('accepts a plain long sentence and flags e-mail', () => {
    expect(containsSecret('Sempre confira o valor total antes de emitir a nota fiscal e '.repeat(3).trim(), [])).toBe(
      false
    );
    expect(containsSecret('mande para a@b.com', [])).toBe(true);
  });
});
