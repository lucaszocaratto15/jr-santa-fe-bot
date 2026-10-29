/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { getSecureInputBroker, getTeachServices, getTeachSession } from '../registry';
import { getSkillsDir } from '@process/utils/initStorage';
import { TEACH_ERRORS } from '../recording/teachSession';
import { readTaughtTask, writeTaughtTask } from '../recording/taskSkillFile';

const requireVault = () => {
  const services = getTeachServices();
  if (!services) throw new Error('JR_VAULT_UNAVAILABLE');
  return services.vault;
};

/** Vault IPC. Only public item data crosses; there is deliberately no secret-reading channel. */
export function initVaultBridge(): void {
  ipcBridge.vault.available.provider(async () => getTeachServices()?.vault.available() ?? false);
  ipcBridge.vault.list.provider(async () => (getTeachServices() ? requireVault().list() : []));
  ipcBridge.vault.upsert.provider(async (input) => requireVault().upsert(input));
  ipcBridge.vault.remove.provider(async ({ id }) => requireVault().remove(id));
}

/** Secure card answers. The typed value goes to the broker and is never sent back. */
export function initSecureInputBridge(): void {
  ipcBridge.teach.secureRespond.provider(async (response) => (await getSecureInputBroker()?.respond(response)) ?? {});
  ipcBridge.teach.secureListPending.provider(async () => getSecureInputBroker()?.listPending() ?? []);
}

const requireSession = () => {
  const session = getTeachSession();
  if (!session) throw new Error(TEACH_ERRORS.unavailable);
  return session;
};

/**
 * The user skills dir the backend lists, imports into and deletes from. Falls back to the
 * desktop's own `getSkillsDir()` when the backend cannot answer.
 */
async function userSkillsDir(): Promise<string> {
  try {
    const { user_skills_dir: dir } = await ipcBridge.fs.getSkillPaths.invoke();
    if (dir) return dir;
  } catch {
    // Backend not reachable: use the desktop's path.
  }
  return getSkillsDir();
}

/** "Ensinar tarefa" IPC: recording controls, draft save and the browser take-over. */
export function initTeachBridge(): void {
  ipcBridge.teach.available.provider(async () => getTeachSession()?.available() ?? false);
  ipcBridge.teach.start.provider(async ({ description }) => requireSession().start(description));
  ipcBridge.teach.pause.provider(async () => requireSession().pause());
  ipcBridge.teach.resume.provider(async () => requireSession().resume());
  ipcBridge.teach.stop.provider(async () => requireSession().stop());
  ipcBridge.teach.discard.provider(async () => requireSession().discard());
  ipcBridge.teach.saveDraft.provider(async (input) => requireSession().saveDraft(input));
  ipcBridge.teach.takeOver.provider(async ({ on }) => requireSession().takeOver(on));
  ipcBridge.teach.takeOverState.provider(async () => getTeachSession()?.takeOverState() ?? { on: false });
  ipcBridge.teach.readTask.provider(async ({ name }) => readTaughtTask(await userSkillsDir(), name));
  ipcBridge.teach.saveTask.provider(async (input) => writeTaughtTask(await userSkillsDir(), input));
}
