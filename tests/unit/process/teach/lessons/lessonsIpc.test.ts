import { describe, expect, it, vi } from 'vitest';
import type { Lesson, LessonProposal } from '@/common/types/agent/lessonTypes';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@process/services/jr/modelConnection', () => ({ getJrModelConnection: () => null }));
vi.mock('@process/services/teach/control/teachIpc', () => ({ userSkillsDir: async () => '/skills' }));
vi.mock('@process/services/teach/lessons/lessonRuntime', () => ({
  getLessonStore: () => null,
  vaultSecrets: async () => [],
}));

import { createLessonsHandlers, type LessonsIpcDeps } from '@/process/services/teach/lessons/lessonsIpc';

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
    connection: () => null,
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
  it('does not mark offered nor count an offer when extraction is empty', async () => {
    const { handlers, store } = setup();
    const result = await handlers.extract({ conversationId: 'c', messages });
    expect(result).toEqual({ proposals: [], upToMessageId: 'm2' });
    expect(store.markOffered).not.toHaveBeenCalled();
    expect(store.bump).not.toHaveBeenCalled();
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
    store.save.mockRejectedValueOnce(Object.assign(new Error('secret'), { code: 'secret' }));
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
