/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { ipcBridge } from '@/common';
import type { JrAccessState } from '@/common/config/clientSettings';
import { createHandbookClient, type HandbookCall } from '@process/services/jr/handbookClient';
import { userSkillsDir } from '../control/teachIpc';
import { getHandbookService, getLearnService, setHandbookService } from '../registry';
import { SKILL_SHOTS_DIRNAME, TAUGHT_SHOTS_DIRNAME } from '../recording/teachSession';
import { createHandbookService, HANDBOOK_DIRNAME, type HandbookService } from './handbookService';

/** Without a service (no JR access controller), every channel fails with `unavailable`. */
const requireService = (): HandbookService => {
  const service = getHandbookService();
  if (!service) throw new Error('unavailable');
  return service;
};

/** "Manual da função" IPC. Publishing only happens on the employee's own approval. */
export function initHandbookBridge(): void {
  ipcBridge.jr.handbook.mine.provider(async () => requireService().mine());
  ipcBridge.jr.handbook.drafts.provider(async () => requireService().drafts());
  ipcBridge.jr.handbook.publish.provider(async ({ key, body, keepShots }) =>
    requireService().publish(key, body, Array.isArray(keepShots) ? keepShots : [])
  );
  ipcBridge.jr.handbook.dismiss.provider(async ({ key }) => requireService().dismiss(key));
  ipcBridge.jr.handbook.withdraw.provider(async ({ itemId }) => requireService().withdraw(itemId));
  ipcBridge.jr.handbook.media.provider(async ({ id }) => requireService().media(id));
  ipcBridge.jr.handbook.draftShot.provider(async ({ key, shot }) => requireService().draftShot(key, shot));
  ipcBridge.jr.handbook.preview.provider(async ({ body }) => requireService().preview(body));
  ipcBridge.jr.handbook.adminRoles.provider(async () => requireService().adminRoles());
  ipcBridge.jr.handbook.adminRole.provider(async ({ key }) => requireService().adminRole(key));
}

/** Create and register the handbook service over the JR access controller's `call`. */
export function startHandbookService(userDataDir: string, call: HandbookCall): HandbookService {
  const service = createHandbookService({
    client: createHandbookClient(call),
    skillsDir: userSkillsDir,
    shotsDirs: (skill, skillsDir) => [
      path.join(skillsDir, skill, SKILL_SHOTS_DIRNAME),
      path.join(userDataDir, TAUGHT_SHOTS_DIRNAME, skill),
    ],
    learn: getLearnService,
    stateFile: path.join(userDataDir, HANDBOOK_DIRNAME, 'state.json'),
  });
  setHandbookService(service);
  // An Aprender revoke that could not reach the server is retried now and hourly while pending.
  service.startWithdrawRetries();
  return service;
}

/** A restored login retries a pending learn-items withdrawal right away. */
export function onHandbookAccessChanged(status: JrAccessState['status']): void {
  if (status !== 'authenticated') return;
  const service = getHandbookService();
  if (!service) return;
  void service.retryPendingWithdraw().catch(() => {});
}
