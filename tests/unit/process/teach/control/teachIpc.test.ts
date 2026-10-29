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
    teach: {
      secureRespond: channel('secureRespond'),
      secureListPending: channel('secureListPending'),
      available: channel('teachAvailable'),
      start: channel('start'),
      pause: channel('pause'),
      resume: channel('resume'),
      stop: channel('stop'),
      discard: channel('discard'),
      saveDraft: channel('saveDraft'),
      takeOver: channel('takeOver'),
      takeOverState: channel('takeOverState'),
    },
  },
}));

import { initSecureInputBridge, initTeachBridge, initVaultBridge } from '@process/services/teach/control/teachIpc';
import { setSecureInputBroker, setTeachServices, setTeachSession } from '@process/services/teach/registry';
import type { TeachSession } from '@process/services/teach/recording/teachSession';
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

describe('teachIpc', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
    setTeachServices({ vault: store, recorder: null });
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

  it('forwards secure card answers and pending lists without values', async () => {
    const respond = vi.fn(async () => ({ saved: false }));
    const pending = [{ id: 'r2', origin: 'https://x.com', kind: 'otp', label: '', allowSave: false, purpose: 'fill' }];
    setSecureInputBroker({ respond, listPending: () => pending } as unknown as SecureInputBroker);
    initSecureInputBridge();
    const response = { id: 'r1', value: '123456' };
    expect(await handlers.secureRespond(response)).toEqual({ saved: false });
    expect(respond).toHaveBeenCalledWith(response);
    expect(await handlers.secureListPending()).toEqual(pending);
    setSecureInputBroker(null);
    expect(await handlers.secureRespond(response)).toEqual({});
    expect(await handlers.secureListPending()).toEqual([]);
  });

  it('routes teach calls to the session and rejects them when teach is off', async () => {
    initTeachBridge();
    setTeachSession(null);
    expect(await handlers.teachAvailable()).toBe(false);
    expect(await handlers.takeOverState()).toEqual({ on: false });
    await expect(handlers.start({ description: 'x' })).rejects.toThrow(/indisponível/);
    const session = {
      available: vi.fn(() => true),
      start: vi.fn(async () => ({ id: 'rec' })),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(async () => ({ id: 'rec' })),
      discard: vi.fn(async () => {}),
      saveDraft: vi.fn(async () => ({ skillPath: '/s' })),
      takeOver: vi.fn(),
      takeOverState: vi.fn(() => ({ on: true })),
    };
    setTeachSession(session as unknown as TeachSession);
    expect(await handlers.teachAvailable()).toBe(true);
    expect(await handlers.start({ description: 'Baixar NFs' })).toEqual({ id: 'rec' });
    expect(session.start).toHaveBeenCalledWith('Baixar NFs');
    await handlers.pause();
    await handlers.resume();
    expect(await handlers.stop()).toEqual({ id: 'rec' });
    await handlers.discard();
    const save = { markdown: '# x', recordingId: 'rec' };
    expect(await handlers.saveDraft(save)).toEqual({ skillPath: '/s' });
    expect(session.saveDraft).toHaveBeenCalledWith(save);
    await handlers.takeOver({ on: true });
    expect(session.takeOver).toHaveBeenCalledWith(true);
    expect(await handlers.takeOverState()).toEqual({ on: true });
    expect(session.pause).toHaveBeenCalled();
    expect(session.resume).toHaveBeenCalled();
    expect(session.discard).toHaveBeenCalled();
    setTeachSession(null);
  });
});
