/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TeachDraftEvent, TeachStateEvent } from '@/common/adapter/ipcBridge';
import { emitter } from '@/renderer/utils/emitter';
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
  takenOver: boolean;
  /** Conversation ids of the mounted card hosts, most recent last. */
  hosts: string[];
};

const initial: TeachUiState = {
  available: false,
  phase: 'idle',
  elapsedMs: 0,
  conversationId: null,
  recordingId: null,
  prompt: null,
  draft: null,
  takenOver: false,
  hosts: [],
};

let state: TeachUiState = initial;
const listeners = new Set<() => void>();

const set = (patch: Partial<TeachUiState>): void => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

const resetFlow = (): void => set({ phase: 'idle', elapsedMs: 0, recordingId: null, prompt: null, draft: null });

/** Sends text as a normal user message of the teach conversation. */
export const sendToTeachConversation = (text: string): void => {
  const target = state.conversationId ?? state.hosts.at(-1);
  if (target) emitter.emit('sendbox.send', text, target);
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
  set({ phase: 'review', draft: event, recordingId: event.recordingId });
};

let subscribed = false;
const ensureSubscribed = (): void => {
  if (subscribed) return;
  subscribed = true;
  ipcBridge.teach.state.on(onState);
  ipcBridge.teach.draft.on(onDraft);
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

export const openDescribe = (): void => {
  const conversationId = state.hosts.at(-1);
  if (!conversationId || state.phase !== 'idle') return;
  set({ phase: 'describing', conversationId });
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

/** The review is over (saved): forget the draft. */
export const endReview = (): void => resetFlow();

export const setTakenOver = async (on: boolean): Promise<void> => {
  await ipcBridge.teach.takeOver.invoke({ on });
  set({ takenOver: on });
};

/** Test helper: back to the initial state (keeps subscriptions). */
export const resetTeachUiForTests = (patch: Partial<TeachUiState> = {}): void => {
  state = { ...initial, ...patch };
  listeners.forEach((listener) => listener());
};
