/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMessageThinking } from '@/common/chat/chatLib';
import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import MessageThinking from '@/renderer/pages/conversation/Messages/components/MessageThinking';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'conversation.thinking.label': 'Preparando a resposta...',
        'conversation.thinking.complete': 'Resposta preparada',
        'common.unit.second_short': 's',
        'common.unit.minute_short': 'min',
      })[key] ?? key,
  }),
}));

function createThinkingMessage(createdAt: number): IMessageThinking {
  return {
    id: 'thinking-1',
    type: 'thinking',
    msg_id: 'msg-1',
    conversation_id: 'conversation-1',
    position: 'left',
    created_at: createdAt,
    content: {
      content: 'analyzing',
      status: 'thinking',
    },
  };
}

describe('MessageThinking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves elapsed time when the component remounts for an active thinking message', () => {
    vi.setSystemTime(new Date('2026-05-26T09:00:10.000Z'));
    const createdAt = Date.now() - 5_000;

    const { unmount } = render(<MessageThinking message={createThinkingMessage(createdAt)} />);

    expect(screen.getByText('Preparando a resposta... · 5s')).toBeInTheDocument();

    unmount();

    vi.setSystemTime(new Date('2026-05-26T09:00:12.000Z'));
    render(<MessageThinking message={createThinkingMessage(createdAt)} />);

    expect(screen.getByText('Preparando a resposta... · 7s')).toBeInTheDocument();
  });
});

describe('employee progress presentation', () => {
  it('keeps internal reasoning and upstream subjects out of the rendered UI', () => {
    const message = createThinkingMessage(Date.now());
    message.content.content = 'Let me inspect the private data and think step by step.';
    message.content.subject = 'Analyzing the request';

    const { container } = render(<MessageThinking message={message} />);

    expect(screen.getByText(/Preparando a resposta/)).toBeInTheDocument();
    expect(container).not.toHaveTextContent('Let me inspect');
    expect(container).not.toHaveTextContent('Analyzing the request');
  });

  it('shows localized completion even when the model returns an empty thought', () => {
    const message = createThinkingMessage(Date.now());
    message.content = { content: '', status: 'done', duration: 1_000 };

    render(<MessageThinking message={message} />);

    expect(screen.getByText('Resposta preparada · 1s')).toBeInTheDocument();
  });

  it('hides the live timer on a JR turn and keeps the finished summary', () => {
    const live = createThinkingMessage(Date.now());
    const { container, rerender } = render(
      <ConversationProvider value={{ conversation_id: 'conversation-1', type: 'aionrs' }}>
        <MessageThinking message={live} />
      </ConversationProvider>
    );

    expect(container).toBeEmptyDOMElement();

    const done = createThinkingMessage(Date.now());
    done.content = { content: '', status: 'done', duration: 2_000 };
    rerender(
      <ConversationProvider value={{ conversation_id: 'conversation-1', type: 'aionrs' }}>
        <MessageThinking message={done} />
      </ConversationProvider>
    );

    expect(screen.getByText('Resposta preparada · 2s')).toBeInTheDocument();
  });

  it('keeps the live timer when the composer is not the JR status line', () => {
    render(
      <ConversationProvider value={{ conversation_id: 'conversation-1', type: 'acp' }}>
        <MessageThinking message={createThinkingMessage(Date.now())} />
      </ConversationProvider>
    );

    expect(screen.getByText(/Preparando a resposta/)).toBeInTheDocument();
  });
});
