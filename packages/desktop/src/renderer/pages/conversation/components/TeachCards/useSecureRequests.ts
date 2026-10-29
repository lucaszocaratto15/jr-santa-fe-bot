/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { SecureRequest } from '@/common/adapter/ipcBridge';
import { useSyncExternalStore } from 'react';

/**
 * Pending secure requests, oldest first. Kept at module level so switching conversations
 * (which remounts the host) does not drop a request the employee has not answered yet.
 */
let queue: SecureRequest[] = [];
const listeners = new Set<() => void>();
let unsubscribeIpc: (() => void) | null = null;

const notify = () => listeners.forEach((listener) => listener());

const subscribe = (listener: () => void): (() => void) => {
  if (!unsubscribeIpc) {
    unsubscribeIpc = ipcBridge.teach.secureRequest.on((request) => {
      if (queue.some((item) => item.id === request.id)) return;
      queue = [...queue, request];
      notify();
    });
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const dismissSecureRequest = (id: string): void => {
  queue = queue.filter((item) => item.id !== id);
  notify();
};

export const useSecureRequests = (): SecureRequest[] => useSyncExternalStore(subscribe, () => queue);
