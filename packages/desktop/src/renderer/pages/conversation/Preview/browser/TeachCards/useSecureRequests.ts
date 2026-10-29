/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { SecureRequest } from '@/common/adapter/ipcBridge';
import { useSyncExternalStore } from 'react';

/**
 * Pending secure requests, oldest first. Kept at module level, and subscribed at module load,
 * so a request emitted before any chat is mounted (or while switching chats) is not lost.
 */
let queue: SecureRequest[] = [];
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

const drop = (id: string): void => {
  if (!queue.some((item) => item.id === id)) return;
  queue = queue.filter((item) => item.id !== id);
  notify();
};

ipcBridge.teach.secureRequest.on((request) => {
  if (queue.some((item) => item.id === request.id)) return;
  queue = [...queue, request];
  notify();
});
ipcBridge.teach.secureExpired.on(({ id }) => drop(id));

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Replaces the queue with main's pending list (main is the source of truth). */
export const resyncSecureRequests = async (): Promise<void> => {
  try {
    queue = await ipcBridge.teach.secureListPending.invoke();
    notify();
  } catch {
    // Keep what we have; the next emit or mount resyncs.
  }
};

export const dismissSecureRequest = (id: string): void => drop(id);

export const useSecureRequests = (): SecureRequest[] => useSyncExternalStore(subscribe, () => queue);
