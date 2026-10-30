/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { ipcBridge } from '@/common';
import type { IConversationTurnCompletedEvent } from '@/common/adapter/ipcBridge';
import type { TMessage } from '@/common/chat/chatLib';
import type { TranscriptMessage } from '@/common/types/agent/lessonTypes';
import { loadLatestConversationMessages } from '@renderer/utils/chat/messagePagination';
import { getLessonCard, showLessonCard } from './lessonCardStore';
import { shouldOffer, stretchAfter, type TriggerMessage } from './lessonTrigger';

const MESSAGE_LIMIT = 200;
const TOOL_TEXT_MAX = 500;

/** A turn counts as successful when it finished without an error or a stop. */
export const isTurnOk = (event: Pick<IConversationTurnCompletedEvent, 'status' | 'state'>): boolean =>
  event.status === 'finished' && event.state !== 'error' && event.state !== 'stopped';

const clipTo = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

const toolSummary = (message: TMessage, max: number): string => {
  const clip = (text: string): string => clipTo(text, max);
  if (message.type === 'tool_call') {
    const { name, output, error } = message.content;
    return clip([name, error || output].filter(Boolean).join(': '));
  }
  if (message.type === 'tool_group') {
    return clip(
      message.content
        .map((tool) => [tool.name, typeof tool.result_display === 'string' ? tool.result_display : ''].join(' ').trim())
        .join('\n')
    );
  }
  return '';
};

/** Chat messages as the extractor's transcript: user/assistant text, tool calls and results as 'tool'. */
export function toTranscript(messages: TMessage[], toolMax: number = TOOL_TEXT_MAX): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const message of messages) {
    if (message.hidden || !message.id) continue;
    if (message.type === 'text') {
      const text = message.content.content;
      if (!text) continue;
      if (message.position === 'right') out.push({ id: message.id, role: 'user', text });
      else if (message.position === 'left') out.push({ id: message.id, role: 'assistant', text });
    } else if (message.type === 'tool_call' || message.type === 'tool_group') {
      const text = toolSummary(message, toolMax);
      if (text) out.push({ id: message.id, role: 'tool', text });
    }
  }
  return out;
}

const inFlight = new Set<string>();

/**
 * After a successful turn, offers lessons when the employee corrected the bot and it got there.
 * One extraction per conversation at a time; any failure is silence.
 */
export function useLessonOffer(conversationId: string): void {
  useEffect(() => {
    // No turn stream (WebUI, mocked bridge): no offers.
    return ipcBridge.conversation?.turnCompleted?.on?.((event) => {
      if (event.session_id !== conversationId) return;
      if (inFlight.has(conversationId) || getLessonCard(conversationId)) return;
      inFlight.add(conversationId);
      void (async () => {
        try {
          const page = await loadLatestConversationMessages(conversationId, {
            limit: MESSAGE_LIMIT,
            contentMode: 'compact',
          });
          const lastOffered = await ipcBridge.teach.lessonsLastOffered.invoke({ conversationId });
          // Cut on the full transcript: the stored marker may be the id of a tool message.
          const stretch = stretchAfter(toTranscript(page.items), lastOffered);
          const chat = stretch.filter((m): m is TriggerMessage => m.role !== 'tool');
          if (!shouldOffer(chat, null, isTurnOk(event))) return;
          // Only the stretch goes out: lessons and their quotes come from this correction alone.
          const result = await ipcBridge.teach.lessonsExtract.invoke({ conversationId, messages: stretch });
          if (result.proposals.length > 0) {
            showLessonCard(conversationId, result.proposals, result.upToMessageId);
          }
        } catch {
          // Extraction failure is silence: no retry, no card.
        } finally {
          inFlight.delete(conversationId);
        }
      })();
    });
  }, [conversationId]);
}
