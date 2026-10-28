import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ptMessages from '@/renderer/services/i18n/locales/pt-BR/messages.json';
import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';
import type { ToolMessage } from '@/common/chat/normalizeToolCall';
import MessageToolCall from '@/renderer/pages/conversation/Messages/components/MessageToolCall';
import MessageToolGroupSummary from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';

vi.mock('@/common', () => ({
  ipcBridge: {
    database: {
      getConversationMessage: {
        invoke: vi.fn(),
      },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      String(
        key
          .split('.')
          .slice(1)
          .reduce<unknown>(
            (value, part) =>
              value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined,
            ptMessages
          ) ?? key
      ).replace('{{count}}', String(options?.count)),
  }),
}));

describe('MessageToolGroupSummary', () => {
  it('loads full tool content when expanding a compact history item', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessage.invoke);
    invoke.mockResolvedValue({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-1',
          status: 'completed',
          title: 'rg',
          kind: 'search',
          raw_input: { pattern: 'needle', path: '.' },
          content: [{ type: 'content', content: { type: 'text', text: 'full output' } }],
        },
      },
    } as unknown as TMessage);

    render(
      <MessageToolGroupSummary
        messages={[
          {
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
          } as unknown as ToolMessage,
        ]}
      />
    );

    fireEvent.click(screen.getByText('1 passos concluídos'));
    fireEvent.click(screen.getByText('rg'));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith({
        conversation_id: 'conversation-1',
        message_id: 'message-1',
      });
    });
    expect(await screen.findByText('full output')).toBeInTheDocument();
  });
});

describe('Portuguese tool presentation', () => {
  it('localizes the tool name and section labels while preserving command and output bytes', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          {
            id: 'exec-1',
            conversation_id: 'conversation-1',
            type: 'tool_call',
            content: {
              call_id: 'exec-1',
              name: 'ExecCommand',
              args: { command: 'node "Read file.mjs"' },
              output: 'stdout ENGLISH payload',
              status: 'completed',
            },
          } as ToolMessage,
        ]}
      />
    );
    fireEvent.click(screen.getByText('1 passos concluídos'));
    fireEvent.click(screen.getByText('Executar comando'));

    expect(screen.getByText('Entrada')).toBeInTheDocument();
    expect(screen.getByText('Saída')).toBeInTheDocument();
    expect(screen.getByText('stdout ENGLISH payload')).toBeInTheDocument();
  });

  it('localizes standalone tool controls and preserves the exact path in the inspected input', () => {
    render(
      <MessageToolCall
        message={{
          id: 'write-standalone',
          conversation_id: 'conversation-1',
          type: 'tool_call',
          content: {
            call_id: 'write-standalone',
            name: 'Write',
            args: { file_path: '/tmp/Write final.mjs' },
            output: 'raw-output',
            status: 'completed',
          },
        }}
      />
    );
    fireEvent.click(screen.getByText('Gravar arquivo'));

    expect(screen.getByText('Entrada')).toBeInTheDocument();
    expect(screen.getByText('Saída')).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/Write final.mjs/)).toBeInTheDocument();
  });

  it('shows a localized failure when full tool output cannot be loaded', async () => {
    vi.mocked(ipcBridge.database.getConversationMessage.invoke).mockRejectedValueOnce(new Error('offline'));
    render(
      <MessageToolGroupSummary
        messages={[
          {
            id: 'read-1',
            conversation_id: 'conversation-1',
            type: 'acp_tool_call',
            content: {
              _compact: { truncated: true },
              update: {
                tool_call_id: 'read-1',
                title: 'Read',
                kind: 'read',
                status: 'pending',
                raw_input: { path: '/tmp/Read file.csv' },
              },
            },
          } as unknown as ToolMessage,
        ]}
      />
    );
    fireEvent.click(screen.getByText('1 passos concluídos'));
    fireEvent.click(screen.getByText('Ler arquivo'));

    expect(await screen.findByText('Não foi possível carregar a saída completa')).toBeInTheDocument();
  });

  it('stays collapsed while running and shows only a live line for the current step', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          {
            id: 'done-1',
            conversation_id: 'conversation-1',
            type: 'tool_call',
            content: { call_id: 'done-1', name: 'Write', status: 'completed' },
          } as ToolMessage,
          {
            id: 'run-1',
            conversation_id: 'conversation-1',
            type: 'tool_call',
            content: { call_id: 'run-1', name: 'ExecCommand', status: 'running' },
          } as ToolMessage,
        ]}
      />
    );

    expect(screen.getByText('1 passos concluídos')).toBeInTheDocument();
    expect(screen.getByTestId('tool-group-live-step')).toHaveTextContent('Executar comando…');
    expect(screen.queryByText('Gravar arquivo')).not.toBeInTheDocument();
  });
});
