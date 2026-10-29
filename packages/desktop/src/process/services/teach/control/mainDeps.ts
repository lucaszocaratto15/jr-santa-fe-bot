/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { webContents } from 'electron';
import { ipcBridge } from '@/common';
import { getCdpBridgeHandle } from '@process/utils/cdpBridgeRegistry';
import { getTeachServices, setSecureInputBroker } from '../registry';
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

/** Wires the control handlers to the real CDP bridge, vault and secure card IPC. */
export function createMainTeachDeps(): TeachHandlerDeps {
  const vault = () => getTeachServices()?.vault ?? null;
  const broker = createSecureInputBroker({
    emit: (request) => ipcBridge.teach.secureRequest.emit(request),
    expired: (id) => ipcBridge.teach.secureExpired.emit({ id }),
    currentOrigin: attachedUrl,
    fill: fillAttached,
    vault,
  });
  setSecureInputBroker(broker);
  return { vault, fill: fillAttached, broker };
}
