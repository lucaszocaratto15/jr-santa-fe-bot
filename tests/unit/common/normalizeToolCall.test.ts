import { describe, expect, it } from 'vitest';
import type { IMessageAcpToolCall } from '@/common/chat/chatLib';
import type { NormalizedToolCall } from '@/common/chat/normalizeToolCall';
import { normalizeAcpToolCall, summarizeToolProgress } from '@/common/chat/normalizeToolCall';

describe('normalizeToolCall', () => {
  it('normalizes compact snake_case acp tool calls from history responses', () => {
    const result = normalizeAcpToolCall({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        _compact: {
          truncated: true,
          original_size: 90000,
          preview_chars: 4096,
        },
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-1',
          status: 'completed',
          title: 'rg',
          kind: 'search',
          raw_input: { pattern: 'needle', path: '.' },
          content: [{ type: 'content', content: { type: 'text', text: 'preview' } }],
        },
      },
    } as unknown as IMessageAcpToolCall);

    expect(result).toMatchObject({
      key: 'tool-1',
      name: 'rg',
      status: 'completed',
      description: '"needle" in .',
      output: 'preview',
      truncated: true,
      messageId: 'message-1',
      conversationId: 'conversation-1',
    });
  });

  it('ignores malformed ACP content items in compact history output', () => {
    const result = normalizeAcpToolCall({
      id: 'message-2',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-2',
          status: 'completed',
          title: 'Edit file',
          kind: 'edit',
          content: [null, 'invalid', { type: 'diff', path: '/workspace/file.ts', old_text: 'old', new_text: 'new' }],
        },
      },
    } as unknown as IMessageAcpToolCall);

    expect(result?.output).toBe('[diff] /workspace/file.ts');
  });
});

describe('summarizeToolProgress', () => {
  const tool = (key: string, status: NormalizedToolCall['status']): NormalizedToolCall => ({ key, name: key, status });

  it('counts finished steps and picks the latest running step as the live one', () => {
    const result = summarizeToolProgress([
      tool('a', 'completed'),
      tool('b', 'error'),
      tool('c', 'running'),
      tool('d', 'running'),
      tool('e', 'pending'),
    ]);

    expect(result.doneCount).toBe(2);
    expect(result.current?.key).toBe('d');
  });

  it('has no live step once nothing is running', () => {
    expect(summarizeToolProgress([tool('a', 'completed'), tool('b', 'canceled')])).toEqual({
      doneCount: 2,
      current: undefined,
    });
  });
});
