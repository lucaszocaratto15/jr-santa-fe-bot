import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
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

  it('recovers from a corrupt file', async () => {
    const { dir, store } = await setup();
    await mkdir(join(dir, 'jr-lessons'), { recursive: true });
    await writeFile(join(dir, 'jr-lessons', 'lessons.json'), '{not json');
    expect(await store.list()).toEqual([]);
    await store.save(general('a'), false);
    const disk = JSON.parse(await readFile(join(dir, 'jr-lessons', 'lessons.json'), 'utf8'));
    expect(disk.lessons).toHaveLength(1);
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
