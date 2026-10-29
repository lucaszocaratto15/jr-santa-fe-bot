/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { useSyncExternalStore } from 'react';

/**
 * Ties a "Manual da função" card (`teach.showHandbook`) to the conversation whose bot asked
 * for it. Main cannot tell which conversation called the `handbook_show` tool (the MCP server
 * is shared), but each conversation's tool frames carry its id: the card goes to the
 * conversation with an in-flight `handbook_show` call close in time to the request, in either
 * order. A card waits for its conversation's host to mount, and is never shown elsewhere.
 */

/** How far apart the tool frame and the card request may arrive. */
export const HANDBOOK_MATCH_WINDOW_MS = 15_000;
const IN_FLIGHT = new Set(['Executing', 'Pending', 'Confirming']);
const HANDBOOK_SHOW_RE = /(?:^|__)handbook_show$/;

type ToolEntry = { name?: unknown; status?: unknown };

/** Whether a stream message is a tool_group with an in-flight `handbook_show` call. */
export const isHandbookShowCall = (type: string, data: unknown): boolean => {
  if (type !== 'tool_group' || !Array.isArray(data)) return false;
  return (data as ToolEntry[]).some(
    (entry) =>
      typeof entry?.name === 'string' && HANDBOOK_SHOW_RE.test(entry.name) && IN_FLIGHT.has(String(entry.status))
  );
};

/** A card request; `roleKey` only when an admin views another role (read-only). */
export type HandbookCardRequest = { activityId: string; roleKey?: string };

let pending: { request: HandbookCardRequest; at: number } | null = null;
/** Conversation id → time of its last in-flight handbook_show frame. */
const calls = new Map<string, number>();
/** Conversation id → the card it shows. */
let cards: Record<string, HandbookCardRequest> = {};
const listeners = new Set<() => void>();

const notify = (): void => listeners.forEach((listener) => listener());

const match = (): void => {
  const now = Date.now();
  for (const [conversationId, at] of calls) {
    if (now - at > HANDBOOK_MATCH_WINDOW_MS) calls.delete(conversationId);
  }
  if (!pending) return;
  if (now - pending.at > HANDBOOK_MATCH_WINDOW_MS) {
    pending = null;
    return;
  }
  let target: string | null = null;
  let latest = -Infinity;
  for (const [conversationId, at] of calls) {
    if (at > latest) {
      target = conversationId;
      latest = at;
    }
  }
  if (!target) return;
  cards = { ...cards, [target]: pending.request };
  calls.delete(target);
  pending = null;
  notify();
};

export const noteHandbookCall = (conversationId: string): void => {
  calls.set(conversationId, Date.now());
  match();
};

export const noteHandbookRequest = (request: HandbookCardRequest): void => {
  pending = { request, at: Date.now() };
  match();
};

export const closeHandbookCard = (conversationId: string): void => {
  if (!(conversationId in cards)) return;
  const { [conversationId]: _closed, ...rest } = cards;
  cards = rest;
  notify();
};

/** Forget every card and pending request (tests). */
export const resetHandbookCards = (): void => {
  pending = null;
  calls.clear();
  cards = {};
  notify();
};

let started = false;
/** Subscribe once, for the app's lifetime, so a request is not lost while no host is mounted. */
export const startHandbookCards = (): void => {
  if (started) return;
  started = true;
  try {
    ipcBridge.teach.showHandbook.on(({ activityId, roleKey }) =>
      noteHandbookRequest(roleKey ? { activityId, roleKey } : { activityId })
    );
    ipcBridge.conversation?.responseStream?.on?.((message) => {
      if (isHandbookShowCall(message.type, message.data)) noteHandbookCall(message.conversation_id);
    });
  } catch {
    // No teach IPC or message stream (WebUI): handbook cards stay hidden.
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The handbook card `conversationId` shows, or null. */
export const useHandbookCard = (conversationId: string): HandbookCardRequest | null =>
  useSyncExternalStore(subscribe, () => cards[conversationId] ?? null);
