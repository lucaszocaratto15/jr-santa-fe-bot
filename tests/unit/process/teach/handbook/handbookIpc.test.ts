import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandbookService } from '@process/services/teach/handbook/handbookService';

const { startWithdrawRetries } = vi.hoisted(() => ({ startWithdrawRetries: vi.fn(() => () => {}) }));

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@process/services/teach/control/teachIpc', () => ({ userSkillsDir: async () => '/skills' }));
vi.mock('@process/services/teach/handbook/handbookService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@process/services/teach/handbook/handbookService')>();
  return {
    ...actual,
    createHandbookService: () => ({ startWithdrawRetries, retryPendingWithdraw: vi.fn(async () => {}) }),
  };
});

import { onHandbookAccessChanged, startHandbookService } from '@process/services/teach/handbook/handbookIpc';
import { setHandbookService } from '@process/services/teach/registry';

afterEach(() => {
  setHandbookService(null);
});

describe('handbook IPC wiring of the pending withdraw', () => {
  it('startup starts the pending withdraw retries', () => {
    startHandbookService('/user-data', async () => ({}));
    expect(startWithdrawRetries).toHaveBeenCalledTimes(1);
  });

  it('a restored login retries a pending withdraw; other access states do not', async () => {
    const retryPendingWithdraw = vi.fn(async () => {});
    setHandbookService({ retryPendingWithdraw } as unknown as HandbookService);
    for (const status of ['offline', 'blocked', 'outside-hours', 'signed-out'] as const) {
      onHandbookAccessChanged(status);
    }
    expect(retryPendingWithdraw).not.toHaveBeenCalled();
    onHandbookAccessChanged('authenticated');
    expect(retryPendingWithdraw).toHaveBeenCalledTimes(1);
  });

  it('a failing retry on login never throws', async () => {
    const retryPendingWithdraw = vi.fn(async () => {
      throw new Error('disk');
    });
    setHandbookService({ retryPendingWithdraw } as unknown as HandbookService);
    expect(() => onHandbookAccessChanged('authenticated')).not.toThrow();
    await Promise.resolve();
  });
});
