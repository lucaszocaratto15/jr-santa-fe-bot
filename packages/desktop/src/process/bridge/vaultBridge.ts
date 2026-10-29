import { ipcBridge } from '@/common';
import { getSecureInputBroker, getTeachServices, getTeachSession } from '@process/services/teach/registry';
import { TEACH_ERRORS } from '@process/services/teach/recording/teachSession';

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
}
