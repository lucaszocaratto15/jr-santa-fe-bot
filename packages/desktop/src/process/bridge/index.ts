/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { initApplicationBridge } from './applicationBridge';
import { initDialogBridge } from './dialogBridge';
import { initUpdateBridge } from './updateBridge';
import { initSystemSettingsBridge } from './systemSettingsBridge';
import { initWindowControlsBridge } from './windowControlsBridge';
import { initNotificationBridge } from './notificationBridge';
import { initWebuiBridge } from './webuiBridge';
import { initThemeBridge } from './themeBridge';
import { initSecureInputBridge, initTeachBridge, initVaultBridge } from '@process/services/teach/control/teachIpc';
import { initLearnBridge } from '@process/services/teach/learn/learnIpc';
import { initLessonsBridge } from '@process/services/teach/lessons/lessonsIpc';
import { initBrainBridge } from '@process/services/brain/brainIpc';
import { initHandbookBridge } from '@process/services/teach/handbook/handbookIpc';

export type BridgeDependencies = Record<string, never>;

export function initAllBridges(_deps: BridgeDependencies = {}): void {
  initDialogBridge();
  initApplicationBridge();
  initWindowControlsBridge();
  initUpdateBridge();
  initSystemSettingsBridge();
  initNotificationBridge();
  initWebuiBridge();
  initThemeBridge();
  initVaultBridge();
  initSecureInputBridge();
  initTeachBridge();
  initLearnBridge();
  initLessonsBridge();
  initHandbookBridge();
  initBrainBridge();
}

export {
  initApplicationBridge,
  initDialogBridge,
  initLearnBridge,
  initNotificationBridge,
  initSystemSettingsBridge,
  initThemeBridge,
  initUpdateBridge,
  initSecureInputBridge,
  initTeachBridge,
  initVaultBridge,
  initWindowControlsBridge,
  initWebuiBridge,
};
export { registerWindowMaximizeListeners } from './windowControlsBridge';
export const disposeAllTeamSessions = (): Promise<void> => Promise.resolve();
