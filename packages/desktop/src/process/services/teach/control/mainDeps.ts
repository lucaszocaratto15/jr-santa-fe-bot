/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { app, webContents } from 'electron';
import { ipcBridge } from '@/common';
import type { SecureRequest } from '@/common/types/agent/teachTypes';
import { showNotification } from '@process/bridge/notificationBridge';
import i18n from '@process/services/i18n';
import { getCdpBridgeHandle } from '@process/utils/cdpBridgeRegistry';
import { getTeachServices, setSecureInputBroker, setTeachSession } from '../registry';
import { createTeachSession, TAUGHT_SHOTS_DIRNAME, TAUGHT_TASKS_DIRNAME } from '../recording/teachSession';
import type { TeachHandlerDeps } from './controlHandlers';
import { FILL_ERRORS, fillFocused } from './secretFill';
import type { FillOptions, FillResult } from './secretFill';
import { createSecureInputBroker } from './secureInput';

const attachedUrl = (): string | null => {
  const id = getCdpBridgeHandle()?.attachedWebContentsId();
  if (id === null || id === undefined) return null;
  return webContents.fromId(id)?.getURL() || null;
};

async function fillAttached(value: string, opts: FillOptions): Promise<FillResult> {
  const bridge = getCdpBridgeHandle();
  if (!bridge || bridge.attachedWebContentsId() === null) return { ok: false, error: FILL_ERRORS.browser };
  return fillFocused(
    {
      bridge,
      // Read live so a tab switch mid-fill is caught by the origin re-check.
      currentUrl: () => attachedUrl() ?? '',
      webContentsId: () => bridge.attachedWebContentsId() ?? -1,
    },
    value,
    opts
  );
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
};

type SecureEmitDeps = {
  emit: (request: SecureRequest) => void;
  notify: (options: { title: string; body: string }) => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
};

/**
 * The broker's `emit`: shows the card first, then raises a desktop notification (2FA in a
 * scheduled run). Only the page's host goes in it, never a value. `showNotification` itself
 * skips while the window is focused or notifications are off. Save-only offers ask no code.
 */
export const notifyingSecureEmit =
  ({ emit, notify, t }: SecureEmitDeps) =>
  (request: SecureRequest): void => {
    emit(request);
    if (request.purpose !== 'fill') return;
    try {
      void notify({
        title: t('common.jr.teach.secure.notifyTitle'),
        body: t('common.jr.teach.secure.notifyBody', { origin: hostOf(request.origin) }),
      }).catch(() => {});
    } catch {
      // A notification failure must never block the secure card.
    }
  };

/** Wires the control handlers to the real CDP bridge, vault, recorder and teach IPC. */
export function createMainTeachDeps(): TeachHandlerDeps {
  const vault = () => getTeachServices()?.vault ?? null;
  const broker = createSecureInputBroker({
    emit: notifyingSecureEmit({
      emit: (request) => ipcBridge.teach.secureRequest.emit(request),
      notify: showNotification,
      t: (key, options) => i18n.t(key, options),
    }),
    expired: (id) => ipcBridge.teach.secureExpired.emit({ id }),
    currentOrigin: attachedUrl,
    fill: fillAttached,
    vault,
  });
  setSecureInputBroker(broker);
  const session = createTeachSession({
    recorder: () => getTeachServices()?.recorder ?? null,
    bridge: getCdpBridgeHandle,
    // R2: the employee retypes the password on a save-only card; skip it without a vault.
    offerSave: (origin) => {
      if (vault()?.available()) broker.offerSave(origin);
    },
    emitState: (event) => ipcBridge.teach.state.emit(event),
    emitDraft: (event) => ipcBridge.teach.draft.emit(event),
    emitDraftRejected: (event) => ipcBridge.teach.draftRejected.emit(event),
    dir: path.join(app.getPath('userData'), TAUGHT_TASKS_DIRNAME),
    shotsDir: path.join(app.getPath('userData'), TAUGHT_SHOTS_DIRNAME),
    maxSkillBytes: async () => {
      const limits = await ipcBridge.fs.getSkillImportLimits.invoke();
      return typeof limits?.max_total_bytes === 'number' && limits.max_total_bytes > 0 ? limits.max_total_bytes : null;
    },
  });
  setTeachSession(session);
  return { vault, fill: fillAttached, broker, submitDraft: (markdown) => session.submitDraft(markdown) };
}
