import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandbookService } from '@process/services/teach/handbook/handbookService';

const { startSync } = vi.hoisted(() => ({ startSync: vi.fn(() => () => {}) }));

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@process/services/teach/control/teachIpc', () => ({ userSkillsDir: async () => '/skills' }));
vi.mock('@process/services/teach/handbook/handbookService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@process/services/teach/handbook/handbookService')>();
  return {
    ...actual,
    createHandbookService: () => ({ startSync, retryPendingWithdraw: vi.fn(async () => {}) }),
  };
});

import { onHandbookAccessChanged, startHandbookService } from '@process/services/teach/handbook/handbookIpc';
import { setHandbookService } from '@process/services/teach/registry';

afterEach(() => {
  setHandbookService(null);
});

describe('handbook IPC wiring of the background sync', () => {
  it('startup starts the background sync', () => {
    startHandbookService('/user-data', async () => ({}));
    expect(startSync).toHaveBeenCalledTimes(1);
  });

  it('a restored login retries a pending withdraw and syncs; other access states do not', async () => {
    const retryPendingWithdraw = vi.fn(async () => {});
    const requestSync = vi.fn();
    setHandbookService({ retryPendingWithdraw, requestSync } as unknown as HandbookService);
    for (const status of ['offline', 'blocked', 'outside-hours', 'signed-out'] as const) {
      onHandbookAccessChanged(status);
    }
    expect(retryPendingWithdraw).not.toHaveBeenCalled();
    expect(requestSync).not.toHaveBeenCalled();
    onHandbookAccessChanged('authenticated');
    expect(retryPendingWithdraw).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(requestSync).toHaveBeenCalledTimes(1));
  });

  it('a failing retry on login never throws', async () => {
    const retryPendingWithdraw = vi.fn(async () => {
      throw new Error('disk');
    });
    const requestSync = vi.fn();
    setHandbookService({ retryPendingWithdraw, requestSync } as unknown as HandbookService);
    expect(() => onHandbookAccessChanged('authenticated')).not.toThrow();
    await vi.waitFor(() => expect(requestSync).toHaveBeenCalledTimes(1));
  });
});
