/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';
import type { LessonProposal } from '@/common/types/agent/lessonTypes';

/** The lessons offered for one conversation, waiting for the employee's per-lesson approval. */
export type LessonCardState = { proposals: LessonProposal[]; upToMessageId: string };

let cards: Record<string, LessonCardState> = {};
const listeners = new Set<() => void>();

const notify = (): void => listeners.forEach((listener) => listener());

export const showLessonCard = (conversationId: string, proposals: LessonProposal[], upToMessageId: string): void => {
  cards = { ...cards, [conversationId]: { proposals, upToMessageId } };
  notify();
};

export const clearLessonCard = (conversationId: string): void => {
  if (!(conversationId in cards)) return;
  const { [conversationId]: _closed, ...rest } = cards;
  cards = rest;
  notify();
};

const getLessonCard = (conversationId: string): LessonCardState | null => cards[conversationId] ?? null;

/** Forget every card (tests). */
export const resetLessonCards = (): void => {
  cards = {};
  notify();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useLessonCard = (conversationId: string): LessonCardState | null =>
  useSyncExternalStore(subscribe, () => getLessonCard(conversationId));

export { getLessonCard };
