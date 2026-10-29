import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

const { calls, saveDraft, importSkill, discard, stop, start, stateListeners, draftListeners, rejectedListeners } =
  vi.hoisted(() => {
    const order: string[] = [];
    return {
      calls: order,
      saveDraft: vi.fn(async (_input: unknown) => {
        order.push('saveDraft');
        return { skillPath: '/data/taught-tasks/rec-1/skill/jr-tarefa-nfs-prefeitura' };
      }),
      importSkill: vi.fn(async (_input: unknown): Promise<{ skill_name: string; failed?: Array<{ code: string }> }> => {
        order.push('importSkill');
        return { skill_name: 'jr-tarefa-nfs-prefeitura' };
      }),
      discard: vi.fn(async () => {
        order.push('discard');
      }),
      stop: vi.fn(async () => ({
        id: 'rec-1',
        timeline: '1. Abriu o portal',
        description: 'Baixar NFs',
        secretOrigins: [],
        prompt: 'PROMPT',
      })),
      start: vi.fn(async (_input: unknown) => ({ id: 'rec-1' })),
      stateListeners: [] as Array<(event: { state: string; elapsedMs: number }) => void>,
      draftListeners: [] as Array<(event: unknown) => void>,
      rejectedListeners: [] as Array<(event: { recordingId: string; error: string }) => void>,
    };
  });

vi.mock('@/common', () => ({
  ipcBridge: {
    teach: {
      saveDraft: { invoke: saveDraft },
      discard: { invoke: discard },
      stop: { invoke: stop },
      start: { invoke: start },
      available: { invoke: async () => true },
      state: { on: (fn: (event: { state: string; elapsedMs: number }) => void) => stateListeners.push(fn) },
      draft: { on: (fn: (event: unknown) => void) => draftListeners.push(fn) },
      draftRejected: {
        on: (fn: (event: { recordingId: string; error: string }) => void) => rejectedListeners.push(fn),
      },
      secureListPending: { invoke: async () => [] },
      secureRequest: { on: () => () => {} },
      secureExpired: { on: () => () => {} },
    },
    fs: { importSkill: { invoke: importSkill } },
  },
}));

import { Message } from '@arco-design/web-react';
import type { TeachDraftEvent } from '@/common/adapter/ipcBridge';
import ReviewCard from '@renderer/pages/conversation/components/TeachCards/ReviewCard';
import TeachCardHost from '@renderer/pages/conversation/components/TeachCards/TeachCardHost';
import {
  beginRecording,
  openDescribe,
  resetTeachUiForTests,
  sendToTeachConversation,
  useTeachUi,
} from '@renderer/pages/conversation/components/TeachCards/teachStore';
import { emitter, type SendBoxSendRequest } from '@renderer/utils/emitter';

const event: TeachDraftEvent = {
  markdown: '---\nname: jr-tarefa-relatorio-nfs\n---\n## Passos\n1. Abrir o portal\n',
  recordingId: 'rec-1',
  draft: {
    name: 'jr-tarefa-relatorio-nfs',
    description: 'Baixa o relatório de NFs do mês.',
    inputs: ['Mês de referência'],
    logins: ['Portal Prefeitura'],
    steps: ['Abrir o portal', 'Entrar com o login do cofre', 'Baixar o PDF'],
    confirmBefore: ['Clicar em "Emitir"'],
  },
};

const sent: Array<[string, string]> = [];
/** Fake send box: claims every request and reports `sendResult`. */
let sendResult = true;
const onSend = (request: SendBoxSendRequest) => {
  request.claimed = true;
  sent.push([request.text, request.conversationId]);
  request.onResult(sendResult);
};

beforeEach(() => {
  calls.length = 0;
  sent.length = 0;
  sendResult = true;
  vi.clearAllMocks();
  resetTeachUiForTests();
  emitter.on('sendbox.send', onSend);
});

afterEach(() => {
  emitter.off('sendbox.send', onSend);
});

describe('ReviewCard', () => {
  it('renders the description, the plain-language rows and the numbered steps', () => {
    render(<ReviewCard event={event} prompt='PROMPT' />);
    expect(screen.getByText('Baixa o relatório de NFs do mês.')).toBeTruthy();
    expect(screen.getByText('Mês de referência')).toBeTruthy();
    expect(screen.getByText('Portal Prefeitura · common.jr.teach.review.vault')).toBeTruthy();
    expect(screen.getByText('Clicar em "Emitir"')).toBeTruthy();
    const steps = [...document.querySelectorAll('ol li')].map((item) => item.textContent);
    expect(steps).toEqual(['Abrir o portal', 'Entrar com o login do cofre', 'Baixar o PDF']);
    expect((screen.getByLabelText('common.jr.teach.review.name') as HTMLInputElement).value).toBe(
      'jr-tarefa-relatorio-nfs'
    );
  });

  it('saves with the edited name, imports the skill directory, then drops the recording', async () => {
    const success = vi.spyOn(Message, 'success').mockImplementation(() => () => undefined);
    render(<ReviewCard event={event} prompt='PROMPT' />);
    fireEvent.change(screen.getByLabelText('common.jr.teach.review.name'), {
      target: { value: 'jr-tarefa-nfs-prefeitura' },
    });
    fireEvent.change(screen.getByLabelText('common.jr.teach.review.description'), {
      target: { value: 'Baixa as NFs da prefeitura.' },
    });
    fireEvent.click(screen.getByText('common.jr.teach.review.save'));
    await waitFor(() => expect(success).toHaveBeenCalledWith('common.jr.teach.review.saved'));
    expect(saveDraft).toHaveBeenCalledWith({
      markdown: event.markdown,
      recordingId: 'rec-1',
      name: 'jr-tarefa-nfs-prefeitura',
      description: 'Baixa as NFs da prefeitura.',
    });
    expect(importSkill).toHaveBeenCalledWith({ skill_path: '/data/taught-tasks/rec-1/skill/jr-tarefa-nfs-prefeitura' });
    expect(calls).toEqual(['saveDraft', 'importSkill', 'discard']);
    success.mockRestore();
  });

  it('shows the error and "Pedir de novo" when the import fails, keeping the recording', async () => {
    importSkill.mockResolvedValueOnce({ skill_name: '', failed: [{ code: 'invalid_frontmatter' }] });
    render(<ReviewCard event={event} prompt='PROMPT' />);
    fireEvent.click(screen.getByText('common.jr.teach.review.save'));
    await waitFor(() => expect(screen.getByText('common.jr.teach.review.saveFailed')).toBeTruthy());
    expect(screen.queryByText(/invalid_frontmatter/)).toBeNull();
    expect(discard).not.toHaveBeenCalled();
    act(() => {
      resetTeachUiForTests({ conversationId: 'c1' });
    });
    fireEvent.click(screen.getByText('common.jr.teach.review.askAgain'));
    expect(sent).toEqual([['PROMPT', 'c1']]);
  });

  it('maps a known save error code to its i18n message', async () => {
    saveDraft.mockRejectedValueOnce(new Error("Error invoking remote method 'teach:save-draft': Error: bad_name"));
    render(<ReviewCard event={event} prompt='PROMPT' />);
    fireEvent.click(screen.getByText('common.jr.teach.review.save'));
    await waitFor(() => expect(screen.getByText('common.jr.teach.errors.bad_name')).toBeTruthy());
    expect(screen.queryByText(/remote method/)).toBeNull();
  });

  it('"Testar agora" sends the draft and the run instruction to the teach conversation', () => {
    resetTeachUiForTests({ conversationId: 'c1' });
    render(<ReviewCard event={event} prompt='PROMPT' />);
    fireEvent.click(screen.getByText('common.jr.teach.review.test'));
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toBe('c1');
    expect(sent[0][0]).toContain(event.markdown);
    expect(sent[0][0]).toContain('common.jr.teach.review.testPrompt {"name":"jr-tarefa-relatorio-nfs"}');
  });
});

describe('teach flow in the card host', () => {
  const Phase: React.FC = () => <span data-testid='phase'>{useTeachUi().phase}</span>;

  it('describe → record → auto-stop sends the prompt to the host conversation → draft shows the review card', async () => {
    render(
      <>
        <TeachCardHost conversationId='c1' />
        <Phase />
      </>
    );
    act(() => openDescribe());
    expect(screen.getByText('common.jr.teach.describe.title')).toBeTruthy();
    await act(() => beginRecording('Baixar NFs'));
    expect(start).toHaveBeenCalledWith({ description: 'Baixar NFs' });
    expect(screen.getByTestId('phase').textContent).toBe('recording');
    act(() => stateListeners.forEach((fn) => fn({ state: 'idle', elapsedMs: 0 })));
    await waitFor(() => expect(sent).toEqual([['PROMPT', 'c1']]));
    expect(screen.getByTestId('phase').textContent).toBe('generating');
    act(() => draftListeners.forEach((fn) => fn(event)));
    expect(screen.getByText('common.jr.teach.review.title')).toBeTruthy();
  });

  it('does not show the review card in another conversation', () => {
    resetTeachUiForTests({ conversationId: 'c1', phase: 'review', draft: event });
    render(<TeachCardHost conversationId='c2' />);
    expect(screen.queryByText('common.jr.teach.review.title')).toBeNull();
  });
});

describe('generating card', () => {
  beforeEach(() => {
    resetTeachUiForTests({ conversationId: 'c1', phase: 'generating', recordingId: 'rec-1', prompt: 'PROMPT' });
  });

  it('"Pedir de novo" re-sends the prompt to the teach conversation', () => {
    render(<TeachCardHost conversationId='c1' />);
    expect(screen.getByText('common.jr.teach.generating.title')).toBeTruthy();
    fireEvent.click(screen.getByText('common.jr.teach.review.askAgain'));
    expect(sent).toEqual([['PROMPT', 'c1']]);
  });

  it('"Descartar" drops the recording in main and resets the flow', async () => {
    const Phase: React.FC = () => <span data-testid='phase'>{useTeachUi().phase}</span>;
    render(
      <>
        <TeachCardHost conversationId='c1' />
        <Phase />
      </>
    );
    fireEvent.click(screen.getByText('common.jr.teach.review.discard'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('idle'));
    expect(discard).toHaveBeenCalled();
    expect(screen.queryByText('common.jr.teach.generating.title')).toBeNull();
  });

  it('shows the i18n message of a refused draft, with a generic fallback', () => {
    render(<TeachCardHost conversationId='c1' />);
    act(() => rejectedListeners.forEach((fn) => fn({ recordingId: 'rec-1', error: 'no_steps' })));
    expect(screen.getByText('common.jr.teach.errors.no_steps')).toBeTruthy();
    act(() => rejectedListeners.forEach((fn) => fn({ recordingId: 'rec-1', error: 'something_new' })));
    expect(screen.getByText('common.jr.teach.generating.rejected')).toBeTruthy();
    act(() => rejectedListeners.forEach((fn) => fn({ recordingId: 'other', error: 'no_steps' })));
    expect(screen.getByText('common.jr.teach.generating.rejected')).toBeTruthy();
  });

  it('shows "Não consegui enviar" when the send box reports a failure', () => {
    sendResult = false;
    render(<TeachCardHost conversationId='c1' />);
    fireEvent.click(screen.getByText('common.jr.teach.review.askAgain'));
    expect(screen.getByText('common.jr.teach.generating.sendFailed')).toBeTruthy();
  });
});

describe('teach store send path', () => {
  const Probe: React.FC = () => <span data-testid='failed'>{String(useTeachUi().sendFailed)}</span>;

  it('records sendFailed when no send box takes the request', () => {
    emitter.off('sendbox.send', onSend);
    resetTeachUiForTests({ conversationId: 'c1' });
    render(<Probe />);
    act(() => sendToTeachConversation('oi'));
    expect(screen.getByTestId('failed').textContent).toBe('true');
  });

  it('records sendFailed when the send box reports failure, and clears it on a good send', () => {
    resetTeachUiForTests({ conversationId: 'c1' });
    render(<Probe />);
    sendResult = false;
    act(() => sendToTeachConversation('oi'));
    expect(screen.getByTestId('failed').textContent).toBe('true');
    sendResult = true;
    act(() => sendToTeachConversation('oi'));
    expect(screen.getByTestId('failed').textContent).toBe('false');
  });

  it('records sendFailed when there is no conversation to send to', () => {
    resetTeachUiForTests();
    render(<Probe />);
    act(() => sendToTeachConversation('oi'));
    expect(screen.getByTestId('failed').textContent).toBe('true');
  });
});
