import { describe, expect, it } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import { authorizedExcerpt } from '@/renderer/pages/Jr/Brain/Notes/noteSelection';

const text = (id: string, position: 'left' | 'right', content: string) =>
  ({ id, type: 'text', position, content: { content } }) as TMessage;

describe('explicit note excerpt', () => {
  it('defaults only to the current reply, not previous private messages', () => {
    expect(
      authorizedExcerpt([
        text('a', 'left', 'Old answer'),
        text('u', 'right', 'Private question'),
        text('b', 'left', 'Current answer'),
      ])
    ).toBe('Current answer');
  });
  it('keeps a selected portion only if it belongs to the current reply', () => {
    expect(authorizedExcerpt([text('b', 'left', 'Current answer')], 'answer')).toBe('answer');
    expect(authorizedExcerpt([text('b', 'left', 'Current answer')], 'unrelated selection')).toBe('Current answer');
  });
  it('does not substitute a user message if no answer exists', () => {
    expect(authorizedExcerpt([text('u', 'right', 'Private question')])).toBe('');
  });
});
