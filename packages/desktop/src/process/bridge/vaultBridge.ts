import { ipcBridge } from '@/common';
import { getTeachServices } from '@process/services/teach/registry';

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
