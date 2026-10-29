/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { BrowserWindow, powerMonitor, safeStorage, shell, systemPreferences, webContents } from 'electron';
import { ipcBridge } from '@/common';
import type { LearnState } from '@/common/types/agent/learnTypes';
import { getJrAccessController } from '@process/services/jr/auth';
import { getJrModelConnection } from '@process/services/jr/modelConnection';
import { getCdpBridgeHandle } from '@process/utils/cdpBridgeRegistry';
import { sanitizeUrl } from '../recording/urlSanitizer';
import { getLearnService, setLearnService } from '../registry';
import { createLearnService, type LearnService } from './learnService';

export const LEARN_UNAVAILABLE = 'LEARN_UNAVAILABLE';
const SCREEN_RECORDING_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/** State reported when no service exists (unsupported platform or not wired yet). */
export const UNAVAILABLE_LEARN_STATE: LearnState = {
  status: 'unavailable',
  unavailableReason: 'platform',
  pausedUntil: null,
  titles: 'full',
  samplerError: false,
  rawHours: 0,
  acceptedVersion: null,
  acceptedAt: null,
  lastInsightsAt: null,
  activeSince: null,
};

const requireService = () => {
  const service = getLearnService();
  if (!service) throw new Error(LEARN_UNAVAILABLE);
  return service;
};

/** "Aprender" IPC. Only state, exclusions and insights cross; raw samples never do. */
export function initLearnBridge(): void {
  ipcBridge.learn.state.provider(async () => getLearnService()?.state() ?? UNAVAILABLE_LEARN_STATE);
  ipcBridge.learn.accept.provider(async ({ termVersion }) => requireService().accept(termVersion));
  ipcBridge.learn.turnOn.provider(async () => requireService().turnOn());
  ipcBridge.learn.pause.provider(async ({ minutes }) => requireService().pause(minutes));
  ipcBridge.learn.resume.provider(async () => requireService().resume());
  ipcBridge.learn.turnOff.provider(async () => requireService().turnOff());
  ipcBridge.learn.revoke.provider(async () => requireService().revoke());
  ipcBridge.learn.getExclusions.provider(async () => requireService().getExclusions());
  ipcBridge.learn.setExclusions.provider(async (rules) => requireService().setExclusions(rules));
  ipcBridge.learn.restoreDefaultExclusions.provider(async () => requireService().restoreDefaultExclusions());
  ipcBridge.learn.listInsights.provider(async () => getLearnService()?.listInsights() ?? []);
  ipcBridge.learn.deleteInsight.provider(async ({ id }) => requireService().deleteInsight(id));
  ipcBridge.learn.generateNow.provider(
    async () => getLearnService()?.generateNow() ?? { ok: false, code: 'unavailable' }
  );
  ipcBridge.learn.wipeSamples.provider(async () => requireService().wipeSamples());
  ipcBridge.learn.openScreenRecordingSettings.provider(async () => {
    if (process.platform !== 'darwin') return;
    await shell.openExternal(SCREEN_RECORDING_URL);
  });
}

/** The page attached to the JR Bot browser (never the JR window title, which names the conversation). */
function jrBrowserPage(): { url: string; title: string } | null {
  const id = getCdpBridgeHandle()?.attachedWebContentsId();
  if (id === null || id === undefined) return null;
  const contents = webContents.fromId(id);
  if (!contents || contents.isDestroyed()) return null;
  const url = sanitizeUrl(contents.getURL());
  if (!/^https?:\/\//.test(url)) return null;
  return { url, title: contents.getTitle() };
}

function currentUser(): { id: string; name: string } | null {
  try {
    const user = getJrAccessController().state.user;
    return user ? { id: user.id, name: user.name } : null;
  } catch {
    return null;
  }
}

/**
 * Create, register and start the learn service with Electron deps. Call after the app is ready
 * (powerMonitor and safeStorage need it). Nothing is sampled until the user accepts the term.
 */
export async function startLearnService(userDataDir: string): Promise<LearnService> {
  let screenLocked = false;
  powerMonitor.on('lock-screen', () => {
    screenLocked = true;
  });
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false;
  });
  const service = createLearnService({
    root: join(userDataDir, 'jr-learn'),
    encryption: safeStorage,
    platform: process.platform,
    spawn,
    now: Date.now,
    setInterval: (callback, ms) => {
      const timer = setInterval(callback, ms);
      timer.unref?.();
      return timer;
    },
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    isLocked: () => screenLocked || powerMonitor.getSystemIdleState(60) === 'locked',
    jrFocused: () => BrowserWindow.getFocusedWindow() !== null,
    jrBrowserPage,
    screenTitlesGranted: () =>
      process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted',
    currentUser,
    connection: getJrModelConnection,
    emit: (state) => ipcBridge.learn.stateChanged.emit(state),
    // Wired by the "Manual da função" plan to withdraw observation items from the server.
    onRevoke: async () => {},
  });
  setLearnService(service);
  await service.init();
  return service;
}
