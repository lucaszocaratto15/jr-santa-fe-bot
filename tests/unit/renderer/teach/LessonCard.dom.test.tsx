import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

const { save, listSkills, listLessons } = vi.hoisted(() => ({
  save: vi.fn(async (_input: unknown) => []),
  listSkills: vi.fn(async () => [{ name: 'jr-tarefa-nfs', description: 'Baixar NFs' }]),
  listLessons: vi.fn(async () => [{ id: 'old-1', text: 'Texto antigo' }]),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    teach: { lessonsSave: { invoke: save }, lessonsList: { invoke: listLessons } },
    fs: { listAvailableSkills: { invoke: listSkills } },
  },
}));

import LessonCard from '@renderer/pages/conversation/Preview/browser/TeachCards/LessonCard';
import {
  getLessonCard,
  resetLessonCards,
  showLessonCard,
} from '@renderer/pages/conversation/Preview/browser/TeachCards/lessonCardStore';
import type { LessonProposal } from '@/common/types/agent/lessonTypes';

const proposals: LessonProposal[] = [
  { text: 'Sempre usar vírgula', scope: { kind: 'general' }, sourceQuote: 'use vírgula' },
  {
    text: 'Conferir o CNPJ na tela',
    scope: { kind: 'task', skill: 'jr-tarefa-nfs' },
    sourceQuote: 'confere',
    updateId: 'old-1',
  },
];

const optionNamed = (name: string) =>
  Array.from(document.querySelectorAll('.arco-select-option')).find((el) => el.textContent === name);

const mount = () => {
  showLessonCard('c1', proposals, 'm9');
  return render(<LessonCard conversationId='c1' proposals={proposals} upToMessageId='m9' />);
};

describe('LessonCard', () => {
  beforeEach(() => {
    save.mockClear();
    save.mockImplementation(async () => []);
  });
  afterEach(() => resetLessonCards());

  it('renders both proposals with quote and the old text of an update', async () => {
    mount();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText(/use vírgula/)).toBeTruthy();
    expect(await screen.findByText('Texto antigo')).toBeTruthy();
    expect(screen.getByText('common.jr.teach.lessons.updates')).toBeTruthy();
  });

  it('unchecking one sends one accepted and discarded:1', async () => {
    mount();
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(screen.getByText('common.jr.teach.lessons.save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      conversationId: 'c1',
      upToMessageId: 'm9',
      accepted: [{ proposal: proposals[0], edited: false }],
      discarded: 1,
    });
    await waitFor(() => expect(getLessonCard('c1')).toBeNull());
  });

  it('editing the text marks edited:true', async () => {
    mount();
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Usar vírgula sempre' } });
    fireEvent.click(screen.getByText('common.jr.teach.lessons.save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const input = save.mock.calls[0][0] as { accepted: Array<{ proposal: LessonProposal; edited: boolean }> };
    expect(input.accepted[0]).toMatchObject({ edited: true, proposal: { text: 'Usar vírgula sempre' } });
    expect(input.accepted[1].edited).toBe(false);
  });

  it('Descartar sends accepted:[] and closes', async () => {
    mount();
    fireEvent.click(screen.getByText('common.jr.teach.lessons.discard'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ conversationId: 'c1', upToMessageId: 'm9', accepted: [], discarded: 2 });
    await waitFor(() => expect(getLessonCard('c1')).toBeNull());
  });

  it('shows the limit message and keeps the card when the store refuses', async () => {
    save.mockImplementation(async () => {
      throw new Error('Error invoking: JR_LESSON_LIMIT_TASK');
    });
    mount();
    fireEvent.click(screen.getByText('common.jr.teach.lessons.save'));
    expect(await screen.findByText('common.jr.teach.lessons.errors.limit_task')).toBeTruthy();
    expect(getLessonCard('c1')).not.toBeNull();
  });

  it('changing only the scope sends edited:true', async () => {
    mount();
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(
      screen.getAllByRole('combobox')[0].closest('.arco-select-view') ?? screen.getAllByRole('combobox')[0]
    );
    await waitFor(() => expect(optionNamed('Baixar NFs')).toBeTruthy());
    fireEvent.click(optionNamed('Baixar NFs')!);
    fireEvent.click(screen.getByText('common.jr.teach.lessons.save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const input = save.mock.calls[0][0] as {
      accepted: Array<{ proposal: LessonProposal; edited: boolean }>;
    };
    expect(input.accepted[0]).toMatchObject({
      edited: true,
      proposal: { text: 'Sempre usar vírgula', scope: { kind: 'task', skill: 'jr-tarefa-nfs' } },
    });
  });

  it('locks the scope of an update proposal to the existing lesson', async () => {
    mount();
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    await act(async () => {});
    const selects = document.querySelectorAll('.arco-select');
    expect(selects[0].classList.contains('arco-select-disabled')).toBe(false);
    expect(selects[1].classList.contains('arco-select-disabled')).toBe(true);
    expect(selects[1].textContent).toContain('Baixar NFs');
  });

  it('shows the secret message on a JR_LESSON_SECRET rejection', async () => {
    save.mockImplementation(async () => {
      throw new Error('JR_LESSON_SECRET');
    });
    mount();
    fireEvent.click(screen.getByText('common.jr.teach.lessons.save'));
    expect(await screen.findByText('common.jr.teach.lessons.errors.secret')).toBeTruthy();
    expect(getLessonCard('c1')).not.toBeNull();
  });

  it('shows the generic message on an unknown error', async () => {
    save.mockImplementation(async () => {
      throw new Error('boom');
    });
    mount();
    fireEvent.click(screen.getByText('common.jr.teach.lessons.save'));
    expect(await screen.findByText('common.jr.teach.lessons.saveFailed')).toBeTruthy();
  });
});
