/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { ipcBridge } from '@/common';
import { loadLatestConversationMessages } from '@renderer/utils/chat/messagePagination';
import { stretchAfter } from './lessonTrigger';
import { isTurnOk, toTranscript } from './useLessonOffer';

const MESSAGE_LIMIT = 200;
/** A stretch with at least one bot answer and this much text is sent right away. */
export const CAPTURE_MIN_CHARS = 300;
/** Otherwise every third turn sends what is pending. */
export const CAPTURE_EVERY_TURNS = 3;
/** Or ten minutes after the last turn. */
export const CAPTURE_IDLE_MS = 10 * 60_000;

const inFlight = new Set<string>();
const turnsSince = new Map<string, number>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Test helper: forgets counters and timers. */
export function resetBrainCapture(): void {
  for (const timer of idleTimers.values()) clearTimeout(timer);
  idleTimers.clear();
  turnsSince.clear();
  inFlight.clear();
}

type Trigger = 'turn' | 'idle';

async function capture(conversationId: string, trigger: Trigger, force: boolean): Promise<void> {
  if (inFlight.has(conversationId)) return;
  inFlight.add(conversationId);
  try {
    const page = await loadLatestConversationMessages(conversationId, {
      limit: MESSAGE_LIMIT,
      contentMode: 'compact',
    });
    const last = await ipcBridge.brain.lastCaptured.invoke({ conversationId });
    // Cut on the full transcript: the stored marker may be the id of a tool message.
    const stretch = stretchAfter(toTranscript(page.items), last);
    const chat = stretch.filter((message) => message.role !== 'tool');
    if (!chat.some((message) => message.role === 'assistant')) return;
    const chars = chat.reduce((sum, message) => sum + message.text.length, 0);
    const turns = turnsSince.get(conversationId) ?? 0;
    const due = trigger === 'idle' || force || chars >= CAPTURE_MIN_CHARS || turns >= CAPTURE_EVERY_TURNS;
    if (!due) return;
    await ipcBridge.brain.captureStretch.invoke({ conversationId, messages: stretch });
    turnsSince.set(conversationId, 0);
  } catch {
    // Capture is silent: no retry here, no message.
  } finally {
    inFlight.delete(conversationId);
  }
}

/**
 * After each finished turn, hands the new stretch of the conversation to main for the company
 * brain when it is long enough, every third turn, or after ten idle minutes. The stretch (user and
 * bot text, tool results as context) leaves only through main, which redacts vault secrets.
 * Never blocks the chat and never shows anything.
 */
export function useBrainCapture(conversationId: string): void {
  useEffect(() => {
    // No turn stream (WebUI, mocked bridge): no capture.
    return ipcBridge.conversation?.turnCompleted?.on?.((event) => {
      if (event.session_id !== conversationId) return;
      const pending = idleTimers.get(conversationId);
      if (pending) clearTimeout(pending);
      idleTimers.delete(conversationId);
      if (!isTurnOk(event)) return;
      turnsSince.set(conversationId, (turnsSince.get(conversationId) ?? 0) + 1);
      // The idle timer outlives the component on purpose: leaving the chat is the usual idle case.
      idleTimers.set(
        conversationId,
        setTimeout(() => {
          idleTimers.delete(conversationId);
          void capture(conversationId, 'idle', false);
        }, CAPTURE_IDLE_MS)
      );
      void capture(conversationId, 'turn', false);
    });
  }, [conversationId]);
}
