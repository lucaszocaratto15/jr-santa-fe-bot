import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, channel, openExternal, powerListeners, emitState } = vi.hoisted(() => {
  const handlers: Record<string, (arg?: unknown) => Promise<unknown>> = {};
  const channel = (name: string) => ({
    provider: (fn: (arg?: unknown) => Promise<unknown>) => {
      handlers[name] = fn;
    },
  });
  return {
    handlers,
    channel,
    openExternal: vi.fn(async () => {}),
    powerListeners: new Map<string, () => void>(),
    emitState: vi.fn(),
  };
});

vi.mock('electron', () => ({
  shell: { openExternal },
  powerMonitor: {
    on: (event: string, listener: () => void) => powerListeners.set(event, listener),
    getSystemIdleTime: () => 0,
    getSystemIdleState: () => 'active',
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (buffer: Buffer) => buffer.toString(),
  },
  BrowserWindow: { getFocusedWindow: () => null },
  webContents: { fromId: () => null },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    learn: Object.fromEntries(
      [
        'state',
        'accept',
        'turnOn',
        'pause',
        'resume',
        'turnOff',
        'revoke',
        'getExclusions',
        'setExclusions',
        'listInsights',
        'deleteInsight',
        'generateNow',
        'wipeSamples',
        'openScreenRecordingSettings',
      ]
        .map((name) => [name, channel(name)])
        .concat([['stateChanged', { emit: emitState }]])
    ),
  },
}));

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initLearnBridge,
  startLearnService,
  UNAVAILABLE_LEARN_STATE,
} from '@process/services/teach/learn/learnIpc';
import { getLearnService, setLearnService } from '@process/services/teach/registry';
import type { LearnService } from '@process/services/teach/learn/learnService';

const active = { ...UNAVAILABLE_LEARN_STATE, status: 'active' as const, unavailableReason: null };

describe('learnIpc', () => {
  beforeEach(() => {
    setLearnService(null);
    initLearnBridge();
  });

  it('accept forwards termVersion and returns the new state', async () => {
    const accept = vi.fn(async () => active);
    setLearnService({ accept } as unknown as LearnService);
    expect(await handlers.accept({ termVersion: '1.2' })).toEqual(active);
    expect(accept).toHaveBeenCalledWith('1.2');
  });

  it('pause forwards minutes, including null', async () => {
    const pause = vi.fn(async () => active);
    setLearnService({ pause } as unknown as LearnService);
    await handlers.pause({ minutes: null });
    await handlers.pause({ minutes: 60 });
    expect(pause.mock.calls).toEqual([[null], [60]]);
  });

  it('without a service, state reports unavailable', async () => {
    expect(await handlers.state()).toEqual(UNAVAILABLE_LEARN_STATE);
    expect(await handlers.listInsights()).toEqual([]);
    expect(await handlers.generateNow()).toEqual({ ok: false, code: 'unavailable' });
  });

  it('without a service, actions reject with LEARN_UNAVAILABLE', async () => {
    await expect(handlers.accept({ termVersion: '1.2' })).rejects.toThrow('LEARN_UNAVAILABLE');
    await expect(handlers.revoke()).rejects.toThrow('LEARN_UNAVAILABLE');
  });

  it('exposes no channel that returns raw samples', () => {
    expect(Object.keys(handlers).filter((name) => /sample/i.test(name))).toEqual(['wipeSamples']);
  });

  it('opens the Screen Recording settings only on macOS', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      await handlers.openScreenRecordingSettings();
      expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('Privacy_ScreenCapture'));
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('startLearnService', () => {
  it('registers an off service, listens for screen lock and writes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'learn-start-'));
    try {
      const service = await startLearnService(dir);
      expect(getLearnService()).toBe(service);
      expect(service.state().status).toBe(process.platform === 'linux' ? 'unavailable' : 'off');
      expect([...powerListeners.keys()].toSorted()).toEqual(['lock-screen', 'unlock-screen']);
      expect(emitState).toHaveBeenCalled();
      await expect(stat(join(dir, 'jr-learn'))).rejects.toThrow();
      service.dispose();
    } finally {
      setLearnService(null);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
