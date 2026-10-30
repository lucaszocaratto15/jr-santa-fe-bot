import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lesson, LessonProposal } from '@/common/types/agent/lessonTypes';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@process/services/jr/modelConnection', () => ({ getJrModelConnection: () => null }));
vi.mock('@process/services/teach/control/teachIpc', () => ({ userSkillsDir: async () => '/skills' }));
vi.mock('@process/services/teach/lessons/lessonRuntime', () => ({
  getLessonStore: () => null,
  vaultSecrets: async () => [],
}));

import { createLessonsHandlers, type LessonsIpcDeps } from '@/process/services/teach/lessons/lessonsIpc';
import { createLessonStore, type SaveItem } from '@/process/services/teach/lessons/lessonStore';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const task = (skill: string, id = 'l1'): Lesson => ({
  id,
  scope: { kind: 'task', skill },
  text: 'Use o botão azul',
  active: true,
  createdAt: 1,
  sourceQuote: 'não, o azul',
  versions: [],
});
const general = (): Lesson => ({ ...task('x'), id: 'g1', scope: { kind: 'general' } });
const proposal = (lesson: Lesson): LessonProposal => ({
  text: lesson.text,
  scope: lesson.scope,
  sourceQuote: lesson.sourceQuote,
});

function setup(overrides: Partial<LessonsIpcDeps> = {}, stored: Lesson[] = []) {
  const store = {
    list: vi.fn(async () => stored),
    save: vi.fn(async (p: LessonProposal) => stored.find((l) => l.text === p.text) ?? task('jr-tarefa-a')),
    saveMany: vi.fn(async (items: SaveItem[]) =>
      items.map(({ proposal: p }) => stored.find((l) => l.text === p.text) ?? task('jr-tarefa-a'))
    ),
    update: vi.fn(async () => stored[0]),
    setActive: vi.fn(async () => stored[0]),
    revert: vi.fn(async () => stored[0]),
    counters: vi.fn(),
    bump: vi.fn(async () => {}),
    lastOffered: vi.fn(async () => 'm9'),
    markOffered: vi.fn(async () => {}),
  };
  const deps: LessonsIpcDeps = {
    store,
    extract: vi.fn(async () => []),
    installedSkills: async () => ['jr-tarefa-a'],
    secrets: async () => [],
    connection: () => ({ url: 'http://relay', token: 't' }) as unknown as ReturnType<LessonsIpcDeps['connection']>,
    syncTask: vi.fn(async () => {}),
    emitChanged: vi.fn(),
    ...overrides,
  };
  return { store, deps, handlers: createLessonsHandlers(deps) };
}

const messages = [
  { id: 'm1', role: 'user' as const, text: 'oi' },
  { id: 'm2', role: 'assistant' as const, text: 'ok' },
];

describe('lessons IPC handlers', () => {
  it('marks the stretch offered but does not count an offer when extraction is empty', async () => {
    const { handlers, store } = setup();
    const result = await handlers.extract({ conversationId: 'c', messages });
    expect(result).toEqual({ proposals: [], upToMessageId: 'm2' });
    expect(store.markOffered).toHaveBeenCalledWith('c', 'm2');
    expect(store.bump).not.toHaveBeenCalled();
  });

  it('does not consume the stretch when there is no connection', async () => {
    const { handlers, store } = setup({ connection: () => null });
    await handlers.extract({ conversationId: 'c', messages });
    expect(store.markOffered).not.toHaveBeenCalled();
  });

  it('counts the offer and marks it when proposals exist', async () => {
    const l = task('jr-tarefa-a');
    const { handlers, store } = setup({ extract: vi.fn(async () => [proposal(l)]) });
    const result = await handlers.extract({ conversationId: 'c', messages });
    expect(result.proposals).toHaveLength(1);
    expect(store.bump).toHaveBeenCalledWith('offered');
    expect(store.markOffered).toHaveBeenCalledWith('c', 'm2');
  });

  it('save marks offered, bumps only discarded and syncs each touched skill once', async () => {
    const a1 = task('jr-tarefa-a', 'a1');
    const a2 = { ...task('jr-tarefa-a', 'a2'), text: 'Outra' };
    const { handlers, store, deps } = setup({}, [a1, a2]);
    await handlers.save({
      conversationId: 'c',
      upToMessageId: 'm2',
      accepted: [
        { proposal: proposal(a1), edited: false },
        { proposal: proposal(a2), edited: true },
      ],
      discarded: 2,
    });
    expect(store.bump.mock.calls).toEqual([['discarded'], ['discarded']]);
    expect(store.markOffered).toHaveBeenCalledWith('c', 'm2');
    expect(deps.syncTask).toHaveBeenCalledTimes(1);
    expect(deps.syncTask).toHaveBeenCalledWith('jr-tarefa-a', [a1, a2]);
    expect(deps.emitChanged).toHaveBeenCalledWith('task');
  });

  it('save propagates a store error carrying its code and does not mark offered', async () => {
    const { handlers, store } = setup();
    store.saveMany.mockRejectedValueOnce(Object.assign(new Error('secret'), { code: 'secret' }));
    await expect(
      handlers.save({
        conversationId: 'c',
        upToMessageId: 'm2',
        accepted: [{ proposal: proposal(task('jr-tarefa-a')), edited: false }],
        discarded: 0,
      })
    ).rejects.toMatchObject({ code: 'secret' });
    expect(store.markOffered).not.toHaveBeenCalled();
  });

  it('save stores nothing when item 2 of the batch passes the task limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jr-lessons-ipc-'));
    roots.push(dir);
    let n = 0;
    const real = createLessonStore(dir, { now: () => 1, secrets: async () => [], newId: () => `id${++n}` });
    const scope = { kind: 'task' as const, skill: 'jr-tarefa-a' };
    for (let i = 0; i < 19; i++) await real.save({ text: `t${i}`, scope, sourceQuote: 'q' }, false);
    const { deps } = setup();
    const handlers = createLessonsHandlers({ ...deps, store: real });
    const input = {
      conversationId: 'c',
      upToMessageId: 'm2',
      accepted: [
        { proposal: { text: 'cabe', scope, sourceQuote: 'q' }, edited: false },
        { proposal: { text: 'não cabe', scope, sourceQuote: 'q' }, edited: false },
      ],
      discarded: 0,
    };
    await expect(handlers.save(input)).rejects.toMatchObject({ code: 'limit_task' });
    expect(await real.list()).toHaveLength(19);
    expect((await real.counters()).saved).toBe(19);
    expect(await real.lastOffered('c')).toBeNull();
    expect(deps.syncTask).not.toHaveBeenCalled();
  });

  it('sends only active lessons to the extractor as existing', async () => {
    const off = { ...general(), id: 'g2', active: false };
    const { handlers, deps } = setup({}, [general(), off]);
    await handlers.extract({ conversationId: 'c', messages });
    expect(vi.mocked(deps.extract).mock.calls[0][0].existing.map((l) => l.id)).toEqual(['g1']);
  });

  it('setActive on a task lesson syncs its skill', async () => {
    const l = task('jr-tarefa-a');
    const { handlers, deps } = setup({}, [l]);
    await handlers.setActive({ id: 'l1', active: false });
    expect(deps.syncTask).toHaveBeenCalledWith('jr-tarefa-a', [l]);
  });

  it('a general change emits lessonsChanged and syncs no task', async () => {
    const g = general();
    const { handlers, deps } = setup({}, [g]);
    await handlers.update({ id: 'g1', text: 'novo' });
    expect(deps.emitChanged).toHaveBeenCalledWith('general');
    expect(deps.syncTask).not.toHaveBeenCalled();
  });

  it('returns the active general lessons as text', async () => {
    const { handlers } = setup({}, [general()]);
    expect(await handlers.generalText()).toBe('- Use o botão azul');
  });
});
