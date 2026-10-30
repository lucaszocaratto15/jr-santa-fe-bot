import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string | number>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  counters: vi.fn(async () => ({ offered: 5, saved: 3, edited: 1, discarded: 2 })),
  update: vi.fn(async (_input: unknown) => ({})),
  setActive: vi.fn(async (_input: unknown) => ({})),
  revert: vi.fn(async (_input: unknown) => ({})),
  skills: vi.fn(async () => [{ name: 'jr-tarefa-nfs', description: 'Baixar NFs' }]),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    teach: {
      lessonsList: { invoke: mocks.list },
      lessonsCounters: { invoke: mocks.counters },
      lessonsUpdate: { invoke: mocks.update },
      lessonsSetActive: { invoke: mocks.setActive },
      lessonsRevert: { invoke: mocks.revert },
      lessonsChanged: { on: () => () => {} },
    },
    fs: { listAvailableSkills: { invoke: mocks.skills } },
  },
}));

import LessonsPanel from '@renderer/pages/Jr/JrSidebar/Teach/LessonsPanel';
import type { Lesson } from '@/common/types/agent/lessonTypes';

const lesson = (over: Partial<Lesson>): Lesson => ({
  id: 'l1',
  scope: { kind: 'general' },
  text: 'Sempre usar vírgula',
  active: true,
  createdAt: 1,
  sourceQuote: 'q',
  versions: [{ text: 'Sempre usar vírgula', at: 1 }],
  ...over,
});

const mount = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <LessonsPanel />
    </SWRConfig>
  );

describe('LessonsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([
      lesson({}),
      lesson({
        id: 'l2',
        scope: { kind: 'task', skill: 'jr-tarefa-nfs' },
        text: 'Conferir o CNPJ',
        versions: [
          { text: 'Conferir CNPJ', at: 1 },
          { text: 'Conferir o CNPJ', at: 2 },
        ],
      }),
    ]);
  });

  it('groups lessons by scope with the task name from the skill description', async () => {
    mount();
    expect(await screen.findByText('Sempre usar vírgula')).toBeTruthy();
    expect(screen.getByText('common.jr.teach.lessons.panel.general')).toBeTruthy();
    expect(await screen.findByText('Baixar NFs')).toBeTruthy();
    expect(screen.getByText('Conferir o CNPJ')).toBeTruthy();
    expect(screen.getByText(/panel\.counters.*"offered":5/)).toBeTruthy();
  });

  it('toggling the switch calls lessonsSetActive', async () => {
    mount();
    await screen.findByText('Sempre usar vírgula');
    fireEvent.click(screen.getAllByRole('switch')[0]);
    await waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith({ id: 'l1', active: false }));
  });

  it('edits a lesson inline and saves with lessonsUpdate', async () => {
    mount();
    await screen.findByText('Sempre usar vírgula');
    fireEvent.click(screen.getAllByLabelText('common.jr.teach.lessons.panel.edit')[0]);
    fireEvent.change(screen.getByLabelText('common.jr.teach.lessons.textLabel'), { target: { value: 'Usar ponto' } });
    fireEvent.click(screen.getByText('common.jr.teach.lessons.save'));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ id: 'l1', text: 'Usar ponto' }));
  });

  it('history modal lists versions and Voltar para esta calls lessonsRevert', async () => {
    mount();
    await screen.findByText('Conferir o CNPJ');
    fireEvent.click(screen.getAllByLabelText('common.jr.teach.lessons.panel.history')[1]);
    expect(await screen.findByText('Conferir CNPJ')).toBeTruthy();
    fireEvent.click(screen.getAllByText('common.jr.teach.lessons.panel.revert')[1]);
    await waitFor(() => expect(mocks.revert).toHaveBeenCalledWith({ id: 'l2', versionIndex: 0 }));
  });

  it('shows the empty state for no lessons', async () => {
    mocks.list.mockResolvedValue([]);
    mount();
    expect(await screen.findByText('common.jr.teach.lessons.panel.emptyTitle')).toBeTruthy();
  });
});
