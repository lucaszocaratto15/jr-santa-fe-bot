import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { TMessage } from '@/common/chat/chatLib';
import type { LessonProposal, TranscriptMessage } from '@/common/types/agent/lessonTypes';

type TurnEvent = { session_id: string; status: string; state?: string };

const { listeners, lastOffered, extract, loadLatest } = vi.hoisted(() => ({
  listeners: [] as Array<(event: TurnEvent) => void>,
  lastOffered: vi.fn(async (_input: { conversationId: string }): Promise<string | null> => null),
  extract: vi.fn(
    async (input: { conversationId: string; messages: TranscriptMessage[] }) =>
      ({ proposals: [] as LessonProposal[], upToMessageId: input.messages.at(-1)?.id ?? '' }) as {
        proposals: LessonProposal[];
        upToMessageId: string;
      }
  ),
  loadLatest: vi.fn(async (): Promise<{ items: TMessage[] }> => ({ items: [] })),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      turnCompleted: {
        on: (listener: (event: TurnEvent) => void) => {
          listeners.push(listener);
          return () => listeners.splice(listeners.indexOf(listener), 1);
        },
      },
    },
    teach: { lessonsLastOffered: { invoke: lastOffered }, lessonsExtract: { invoke: extract } },
  },
}));
vi.mock('@renderer/utils/chat/messagePagination', () => ({ loadLatestConversationMessages: loadLatest }));

import { useLessonOffer } from '@renderer/pages/conversation/Preview/browser/TeachCards/useLessonOffer';
import {
  getLessonCard,
  resetLessonCards,
} from '@renderer/pages/conversation/Preview/browser/TeachCards/lessonCardStore';

const text = (id: string, position: 'left' | 'right', content: string) =>
  ({ id, type: 'text', position, content: { content } }) as unknown as TMessage;
const tool = (id: string) =>
  ({ id, type: 'tool_call', content: { name: 'navegar', output: 'ok' } }) as unknown as TMessage;

/** An earlier corrected stretch (already offered at `t1`), then a new one that ends with approval. */
const history: TMessage[] = [
  text('u1', 'right', 'não, use sempre o relatório antigo de vendas'),
  text('a1', 'left', 'ok'),
  text('u2', 'right', 'isso'),
  tool('t1'),
  text('u3', 'right', 'baixe as notas'),
  text('a3', 'left', 'baixei'),
  text('u4', 'right', 'não, filtre pelo mês passado primeiro'),
  text('a4', 'left', 'feito'),
  text('u5', 'right', 'agora sim'),
];

const finishTurn = () => listeners.forEach((listener) => listener({ session_id: 'c1', status: 'finished' }));

describe('useLessonOffer', () => {
  beforeEach(() => {
    loadLatest.mockResolvedValue({ items: history });
    lastOffered.mockResolvedValue('t1');
    extract.mockClear();
  });
  afterEach(() => resetLessonCards());

  it('sends only the stretch after a marker that is a tool message', async () => {
    renderHook(() => useLessonOffer('c1'));
    finishTurn();
    await waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    const sent = extract.mock.calls[0][0].messages;
    expect(sent.map((m) => m.id)).toEqual(['u3', 'a3', 'u4', 'a4', 'u5']);
    // A quote from before the marker never reaches the extractor.
    expect(JSON.stringify(sent)).not.toContain('relatório antigo');
  });

  it('does not extract when the stretch after the tool marker has too few user messages', async () => {
    loadLatest.mockResolvedValue({ items: [...history.slice(0, 4), text('u9', 'right', 'isso')] });
    renderHook(() => useLessonOffer('c1'));
    finishTurn();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(extract).not.toHaveBeenCalled();
  });

  it('shows no card when the extraction returns no proposals (corrected:false)', async () => {
    renderHook(() => useLessonOffer('c1'));
    finishTurn();
    await waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getLessonCard('c1')).toBeNull();
  });

  it('shows the card when the extraction returns proposals', async () => {
    extract.mockResolvedValueOnce({
      proposals: [{ text: 'Filtre pelo mês passado', scope: { kind: 'general' }, sourceQuote: 'filtre pelo mês' }],
      upToMessageId: 'u5',
    });
    renderHook(() => useLessonOffer('c1'));
    finishTurn();
    await waitFor(() => expect(getLessonCard('c1')).not.toBeNull());
    expect(getLessonCard('c1')?.upToMessageId).toBe('u5');
  });
});
