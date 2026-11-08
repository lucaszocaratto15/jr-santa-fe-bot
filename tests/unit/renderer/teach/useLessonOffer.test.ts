import { describe, expect, it } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import { isTurnOk, toTranscript } from '@renderer/pages/conversation/Preview/browser/TeachCards/useLessonOffer';

const text = (id: string, position: 'left' | 'right', content: string, extra: object = {}) =>
  ({ id, type: 'text', position, content: { content }, ...extra }) as unknown as TMessage;

describe('toTranscript', () => {
  it('maps right text to user, left text to assistant, in order', () => {
    expect(toTranscript([text('1', 'right', 'oi'), text('2', 'left', 'ola')])).toEqual([
      { id: '1', role: 'user', text: 'oi' },
      { id: '2', role: 'assistant', text: 'ola' },
    ]);
  });

  it('skips hidden, empty and unsupported messages', () => {
    const tips = { id: '9', type: 'tips', content: { content: 'x' } } as unknown as TMessage;
    expect(
      toTranscript([
        text('1', 'right', 'a', { hidden: true }),
        text('2', 'left', ''),
        text('3', 'center' as never, 'c'),
        tips,
      ])
    ).toEqual([]);
  });

  it('summarizes tool calls and groups as tool messages, clipped to 500 chars', () => {
    const call = {
      id: 't1',
      type: 'tool_call',
      content: { call_id: 'c', name: 'search', args: {}, error: '', output: 'x'.repeat(900) },
    } as unknown as TMessage;
    const group = {
      id: 't2',
      type: 'tool_group',
      content: [{ call_id: 'c', name: 'read', result_display: 'done' }],
    } as unknown as TMessage;
    const [first, second] = toTranscript([call, group]);
    expect(first.role).toBe('tool');
    expect(first.text).toHaveLength(500);
    expect(first.text.startsWith('search: xxx')).toBe(true);
    expect(second).toEqual({ id: 't2', role: 'tool', text: 'read done' });
  });
});

describe('isTurnOk', () => {
  it('accepts a finished turn and rejects error, stopped and unfinished ones', () => {
    expect(isTurnOk({ status: 'finished', state: 'ai_waiting_input' })).toBe(true);
    expect(isTurnOk({ status: 'finished', state: 'error' })).toBe(false);
    expect(isTurnOk({ status: 'finished', state: 'stopped' })).toBe(false);
    expect(isTurnOk({ status: 'running', state: 'ai_generating' })).toBe(false);
  });
});
