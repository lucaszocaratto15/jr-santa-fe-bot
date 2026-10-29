/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TeachDraftEvent, TeachDraftRejectedEvent, TeachStateEvent } from '@/common/adapter/ipcBridge';
import { emitter, type SendBoxSendRequest } from '@/renderer/utils/emitter';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Renderer side of "Ensinar tarefa": which card or bar is showing, and the conversation the
 * draft prompt goes to. Module level, shared by the browser toolbar and the chat card host.
 * Main is the source of truth for the recorder; this only follows `teach.state`.
 */
export type TeachPhase =
  | 'idle'
  | 'describing'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'discarding'
  | 'generating'
  | 'review';

export type TeachUiState = {
  available: boolean;
  phase: TeachPhase;
  elapsedMs: number;
  /** Conversation that receives the draft prompt and shows the review card. */
  conversationId: string | null;
  recordingId: string | null;
  prompt: string | null;
  draft: TeachDraftEvent | null;
  /** The last message to the bot could not be sent (no send box, queue full, send error). */
  sendFailed: boolean;
  /** Code of the bot's last refused draft (shown on the generating card). */
  draftError: TeachDraftRejectedEvent['error'] | null;
  takenOver: boolean;
  /** Conversation ids of the mounted card hosts, most recent last. */
  hosts: string[];
  /** Text the describe card starts with (the "Ensinar esta tarefa" shortcut). */
  describePrefill: string | null;
};

const initial: TeachUiState = {
  available: false,
  phase: 'idle',
  elapsedMs: 0,
  conversationId: null,
  recordingId: null,
  prompt: null,
  draft: null,
  sendFailed: false,
  draftError: null,
  takenOver: false,
  hosts: [],
  describePrefill: null,
};

let state: TeachUiState = initial;
const listeners = new Set<() => void>();

const set = (patch: Partial<TeachUiState>): void => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

const resetFlow = (): void =>
  set({
    phase: 'idle',
    elapsedMs: 0,
    recordingId: null,
    prompt: null,
    draft: null,
    sendFailed: false,
    draftError: null,
  });

/**
 * Sends text as a normal user message of the teach conversation. Failure (no send box of
 * that conversation mounted, queue refused, send rejected) is recorded as `sendFailed`.
 */
export const sendToTeachConversation = (text: string): void => {
  const conversationId = state.conversationId ?? state.hosts.at(-1);
  set({ sendFailed: false, draftError: null });
  if (!conversationId) {
    set({ sendFailed: true });
    return;
  }
  const request: SendBoxSendRequest = {
    text,
    conversationId,
    claimed: false,
    onResult: (ok) => {
      if (!ok) set({ sendFailed: true });
    },
  };
  emitter.emit('sendbox.send', request);
  if (!request.claimed) set({ sendFailed: true });
};

/** Stops the recording and asks the bot for a draft. Rejects when main could not stop. */
export const finishRecording = async (): Promise<void> => {
  set({ phase: 'stopping' });
  try {
    const stopped = await ipcBridge.teach.stop.invoke();
    set({ phase: 'generating', elapsedMs: 0, recordingId: stopped.id, prompt: stopped.prompt });
    sendToTeachConversation(stopped.prompt);
  } catch (error) {
    resetFlow();
    throw error;
  }
};

const onState = (event: TeachStateEvent): void => {
  const { phase } = state;
  if (phase === 'stopping' || phase === 'discarding') return;
  if (event.state === 'idle') {
    // The recorder stopped on its own (10-minute limit): continue as if "Concluir".
    if (phase === 'recording' || phase === 'paused') void finishRecording().catch(() => {});
    return;
  }
  // Also adopts a recording that started before this window loaded.
  if (phase === 'generating' || phase === 'review') return;
  set({ phase: event.state, elapsedMs: event.elapsedMs });
};

const onDraft = (event: TeachDraftEvent): void => {
  set({ phase: 'review', draft: event, recordingId: event.recordingId, sendFailed: false, draftError: null });
};

const onDraftRejected = (event: TeachDraftRejectedEvent): void => {
  if (state.phase === 'generating' && event.recordingId === state.recordingId) set({ draftError: event.error });
};

let subscribed = false;
const ensureSubscribed = (): void => {
  if (subscribed) return;
  subscribed = true;
  ipcBridge.teach.state.on(onState);
  ipcBridge.teach.draft.on(onDraft);
  ipcBridge.teach.draftRejected.on(onDraftRejected);
  ipcBridge.teach.available
    .invoke()
    .then((available) => set({ available }))
    .catch(() => set({ available: false }));
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Current teach UI state; subscribes to main's teach events on first use. */
export const useTeachUi = (): TeachUiState => {
  useEffect(() => {
    try {
      ensureSubscribed();
    } catch {
      // No teach IPC (tests, WebUI): the teach UI stays hidden.
      subscribed = false;
    }
  }, []);
  return useSyncExternalStore(subscribe, () => state);
};

/** A chat card host mounted for `conversationId`; returns its cleanup. */
export const registerTeachHost = (conversationId: string): (() => void) => {
  set({ hosts: [...state.hosts.filter((id) => id !== conversationId), conversationId] });
  return () => set({ hosts: state.hosts.filter((id) => id !== conversationId) });
};

export const openDescribe = (prefill?: string): void => {
  const conversationId = state.hosts.at(-1);
  if (!conversationId || state.phase !== 'idle') return;
  set({ phase: 'describing', conversationId, describePrefill: prefill ?? null });
};

/**
 * What a conversation should do once its chat mounts: open the in-app browser (the agent
 * only controls it while the tab is mounted) and optionally the prefilled describe card.
 */
export type ConversationIntent = { openBrowser: true; url?: string; describe?: string };

const intents = new Map<string, ConversationIntent>();

/** Queues an intent for the next time `conversationId`'s card host mounts. */
export const queueConversationIntent = (conversationId: string, intent: ConversationIntent): void => {
  intents.set(conversationId, intent);
};

/** The queued intent of `conversationId`, returned once and then cleared. */
export const takeConversationIntent = (conversationId: string): ConversationIntent | null => {
  const intent = intents.get(conversationId) ?? null;
  intents.delete(conversationId);
  return intent;
};

export const cancelDescribe = (): void => {
  if (state.phase === 'describing') set({ phase: 'idle' });
};

export const beginRecording = async (description: string): Promise<void> => {
  await ipcBridge.teach.start.invoke({ description });
  // The recorder holds the browser lock now; a previous take-over no longer applies.
  set(state.phase === 'describing' ? { phase: 'recording', elapsedMs: 0, takenOver: false } : { takenOver: false });
};

export const pauseRecording = async (): Promise<void> => {
  await ipcBridge.teach.pause.invoke();
  set({ phase: 'paused' });
};

export const resumeRecording = async (): Promise<void> => {
  await ipcBridge.teach.resume.invoke();
  set({ phase: 'recording' });
};

/** Drops the active or awaiting recording (and its raw files) in main. */
export const discardRecording = async (): Promise<void> => {
  set({ phase: 'discarding' });
  try {
    await ipcBridge.teach.discard.invoke();
  } finally {
    resetFlow();
  }
};

/** Reads main's take-over state (a reload must still show "Devolver ao bot"). */
export const resyncTakeOver = async (): Promise<void> => {
  try {
    const { on } = await ipcBridge.teach.takeOverState.invoke();
    set({ takenOver: on });
  } catch {
    // Keep what we have.
  }
};

export const setTakenOver = async (on: boolean): Promise<void> => {
  await ipcBridge.teach.takeOver.invoke({ on });
  set({ takenOver: on });
};

/** Test helper: back to the initial state (keeps subscriptions). */
export const resetTeachUiForTests = (patch: Partial<TeachUiState> = {}): void => {
  state = { ...initial, ...patch };
  listeners.forEach((listener) => listener());
};

const KNOWN_ERRORS = ['too_large', 'no_frontmatter', 'bad_name', 'no_description', 'no_steps', 'no_review'] as const;
export type TeachKnownError = (typeof KNOWN_ERRORS)[number];

/**
 * The known teach error code inside `message` (main sends codes; IPC may wrap them in
 * "Error invoking …"), or null. Raw backend text is never shown to the employee.
 */
export const knownTeachError = (message: string | null | undefined): TeachKnownError | null => {
  if (!message) return null;
  return KNOWN_ERRORS.find((code) => new RegExp(`\\b${code}\\b`).test(message)) ?? null;
};
