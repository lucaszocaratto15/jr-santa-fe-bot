import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, channel } = vi.hoisted(() => {
  const handlers: Record<string, (arg?: unknown) => Promise<unknown>> = {};
  const channel = (name: string) => ({
    provider: (fn: (arg?: unknown) => Promise<unknown>) => {
      handlers[name] = fn;
    },
  });
  return { handlers, channel };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    vault: {
      available: channel('available'),
      list: channel('list'),
      upsert: channel('upsert'),
      remove: channel('remove'),
    },
    teach: { secureRespond: channel('secureRespond') },
  },
}));

import { initSecureInputBridge, initVaultBridge } from '@process/bridge/vaultBridge';
import { setSecureInputBroker, setTeachServices } from '@process/services/teach/registry';
import type { SecureInputBroker } from '@process/services/teach/control/secureInput';
import type { VaultStore } from '@process/services/teach/vault/vault';

const item = { id: 'a', name: 'CRTI', origins: ['https://x.com'], username: 'u', hasPassword: true, hints: '' };
const makeStore = () =>
  ({
    available: vi.fn(() => true),
    list: vi.fn(async () => [item]),
    upsert: vi.fn(async () => item),
    remove: vi.fn(async () => undefined),
    wipe: vi.fn(),
    readSecret: vi.fn(),
  }) as unknown as VaultStore & Record<string, ReturnType<typeof vi.fn>>;

describe('vaultBridge', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
    setTeachServices({ vault: store });
    initVaultBridge();
  });

  it('passes calls through to the store', async () => {
    expect(await handlers.available()).toBe(true);
    expect(await handlers.list()).toEqual([item]);
    const input = { name: 'CRTI', origins: ['https://x.com'], username: 'u' };
    expect(await handlers.upsert(input)).toEqual(item);
    expect(store.upsert).toHaveBeenCalledWith(input);
    await handlers.remove({ id: 'a' });
    expect(store.remove).toHaveBeenCalledWith('a');
  });

  it('reports unavailable and lists nothing before services exist', async () => {
    setTeachServices(null);
    expect(await handlers.available()).toBe(false);
    expect(await handlers.list()).toEqual([]);
    await expect(handlers.upsert({})).rejects.toThrow('JR_VAULT_UNAVAILABLE');
  });

  it('never exposes a secret-reading channel', async () => {
    const actual = await vi.importActual<typeof import('@/common/adapter/ipcBridge')>('@/common/adapter/ipcBridge');
    expect(Object.keys(actual.vault)).toEqual(['available', 'list', 'upsert', 'remove']);
  });

  it('forwards secure card answers to the broker and returns nothing', async () => {
    const respond = vi.fn(async () => undefined);
    setSecureInputBroker({ respond } as unknown as SecureInputBroker);
    initSecureInputBridge();
    const response = { id: 'r1', value: '123456' };
    expect(await handlers.secureRespond(response)).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(response);
    setSecureInputBroker(null);
    expect(await handlers.secureRespond(response)).toBeUndefined();
  });
});
