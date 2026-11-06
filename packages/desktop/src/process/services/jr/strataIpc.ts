import { shell } from 'electron';
import { ipcBridge } from '@/common';
import { getJrAccessController } from './auth';
import { createStrataClient } from './strataClient';
import { getLearnService } from '../teach/registry';
import { isObservedErpRead } from '../teach/learn/workflow/model';

let knownStatus: { ownerId: string; key: string } | null = null;

export const getStrataClient = () => {
  const client = createStrataClient((path, init) => getJrAccessController().strataCall(path, init));
  return {
    ...client,
    async callTool(input: Parameters<typeof client.callTool>[0]) {
      const complete = getLearnService()?.beginWorkEvent('erp.read');
      const result = await client.callTool(input);
      if (complete && isObservedErpRead(input.name, result)) await complete().catch(() => {});
      return result;
    },
  };
};

/** Starts account linking in the browser using a URL produced by the authenticated backend. */
export function initStrataBridge(): void {
  ipcBridge.jr.strata.status.provider(async () => {
    const ownerId = getJrAccessController().state.user?.id;
    const result = await getStrataClient().status();
    const key = JSON.stringify([result.linked, result.erpUser?.id ?? null, result.organizationId]);
    if (ownerId && knownStatus?.ownerId === ownerId && knownStatus.key !== key)
      ipcBridge.jr.strata.changed.emit({ reason: 'connection' });
    knownStatus = ownerId ? { ownerId, key } : null;
    return result;
  });
  ipcBridge.jr.strata.connect.provider(async () => {
    const controller = getJrAccessController();
    const before = controller.state.user?.id;
    const result = await getStrataClient().connect();
    if (!before || controller.state.status !== 'authenticated' || controller.state.user?.id !== before)
      throw new Error('JR_ACCESS_REQUIRED');
    await shell.openExternal(result.authorizationUrl);
    ipcBridge.jr.strata.changed.emit({ reason: 'connection' });
    return { expiresAt: result.expiresAt };
  });
  ipcBridge.jr.strata.disconnect.provider(async () => {
    await getStrataClient().disconnect();
    knownStatus = null;
    ipcBridge.jr.strata.changed.emit({ reason: 'disconnection' });
  });
}
