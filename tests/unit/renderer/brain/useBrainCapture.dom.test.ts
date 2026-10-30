import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { TMessage } from '@/common/chat/chatLib';

type TurnEvent = { session_id: string; status: string; state?: string };

const { listeners, lastCaptured, captureStretch, loadLatest } = vi.hoisted(() => ({
  listeners: [] as Array<(event: TurnEvent) => void>,
  lastCaptured: vi.fn(async (_input: { conversationId: string }): Promise<string | null> => null),
  captureStretch: vi.fn(async (_input: { conversationId: string; messages: Array<{ id: string }> }) => {}),
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
    brain: { lastCaptured: { invoke: lastCaptured }, captureStretch: { invoke: captureStretch } },
  },
}));
vi.mock('@renderer/utils/chat/messagePagination', () => ({ loadLatestConversationMessages: loadLatest }));

import {
  CAPTURE_IDLE_MS,
  resetBrainCapture,
  useBrainCapture,
} from '@renderer/pages/conversation/Preview/browser/TeachCards/useBrainCapture';

const text = (id: string, position: 'left' | 'right', content: string) =>
  ({ id, type: 'text', position, content: { content } }) as unknown as TMessage;
const turn = (event: Partial<TurnEvent> = {}) =>
  listeners.forEach((listener) => listener({ session_id: 'c1', status: 'finished', ...event }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

describe('useBrainCapture', () => {
  beforeEach(() => {
    loadLatest.mockResolvedValue({ items: [text('u1', 'right', 'oi'), text('a1', 'left', 'olá')] });
    lastCaptured.mockResolvedValue(null);
    captureStretch.mockClear();
  });
  afterEach(() => resetBrainCapture());

  it('does not send a short stretch on the first turn', async () => {
    renderHook(() => useBrainCapture('c1'));
    turn();
    await settle();
    expect(captureStretch).not.toHaveBeenCalled();
  });

  it('sends when the stretch has a bot answer and 300 characters, only after the marker', async () => {
    loadLatest.mockResolvedValue({
      items: [text('u0', 'right', 'antigo'), text('u1', 'right', 'x'.repeat(200)), text('a1', 'left', 'y'.repeat(150))],
    });
    lastCaptured.mockResolvedValue('u0');
    renderHook(() => useBrainCapture('c1'));
    turn();
    await settle();
    expect(captureStretch).toHaveBeenCalledTimes(1);
    expect(captureStretch.mock.calls[0][0].messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('sends every third turn even when short', async () => {
    renderHook(() => useBrainCapture('c1'));
    turn();
    await settle();
    turn();
    await settle();
    expect(captureStretch).not.toHaveBeenCalled();
    turn();
    await settle();
    expect(captureStretch).toHaveBeenCalledTimes(1);
  });

  it('sends after ten idle minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      renderHook(() => useBrainCapture('c1'));
      turn();
      await vi.advanceTimersByTimeAsync(CAPTURE_IDLE_MS + 10);
      await vi.waitFor(() => expect(captureStretch).toHaveBeenCalledTimes(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores other conversations and failed turns, and never throws', async () => {
    captureStretch.mockRejectedValueOnce(new Error('boom'));
    loadLatest.mockResolvedValue({
      items: [text('u1', 'right', 'x'.repeat(200)), text('a1', 'left', 'y'.repeat(150))],
    });
    renderHook(() => useBrainCapture('c1'));
    turn({ session_id: 'other' });
    turn({ status: 'finished', state: 'error' });
    await settle();
    expect(captureStretch).not.toHaveBeenCalled();
    turn();
    await settle();
    expect(captureStretch).toHaveBeenCalledTimes(1);
  });

  it('never sends the bot own brain lookups (brain_search, brain_wrong), keeping other tools', async () => {
    const toolCall = (id: string, name: string) =>
      ({ id, type: 'tool_call', content: { name, output: 'Fato alto: preço 10' } }) as unknown as TMessage;
    const group = (id: string, names: string[]) =>
      ({
        id,
        type: 'tool_group',
        content: names.map((name) => ({ name, result_display: `${name} resultado` })),
      }) as unknown as TMessage;
    loadLatest.mockResolvedValue({
      items: [
        text('u1', 'right', 'x'.repeat(200)),
        toolCall('t1', 'jr-teach__brain_search'),
        toolCall('t2', 'brain_wrong'),
        group('g1', ['mcp__jr-teach__brain_search', 'web_fetch']),
        group('g2', ['brain_search']),
        text('a1', 'left', 'y'.repeat(150)),
      ],
    });
    renderHook(() => useBrainCapture('c1'));
    turn();
    await settle();
    const sent = captureStretch.mock.calls[0][0].messages as Array<{ id: string; text?: string }>;
    expect(sent.map((m) => m.id)).toEqual(['u1', 'g1', 'a1']);
    expect(sent[1].text).not.toMatch(/brain_search/);
    expect(sent[1].text).toMatch(/web_fetch/);
  });
});
