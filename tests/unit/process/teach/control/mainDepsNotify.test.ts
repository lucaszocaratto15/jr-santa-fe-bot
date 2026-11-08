import { describe, expect, it, vi } from 'vitest';
import type { SecureRequest } from '@/common/types/agent/teachTypes';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, webContents: { fromId: () => null } }));
vi.mock('@/common', () => ({ ipcBridge: { teach: {} } }));
vi.mock('@process/utils/cdpBridgeRegistry', () => ({ getCdpBridgeHandle: () => null }));
vi.mock('@process/bridge/notificationBridge', () => ({ showNotification: vi.fn() }));
vi.mock('@process/services/i18n', () => ({ default: { t: (key: string) => key } }));

import { notifyingSecureEmit } from '@process/services/teach/control/mainDeps';

const request = (patch: Partial<SecureRequest> = {}): SecureRequest => ({
  id: 'r1',
  origin: 'https://portal.gov.br',
  kind: 'otp',
  label: 'Código',
  allowSave: false,
  purpose: 'fill',
  ...patch,
});

const t = (key: string, options?: Record<string, unknown>) =>
  options?.origin ? `${key}:${String(options.origin)}` : key;

describe('notifyingSecureEmit', () => {
  it('emits the secure request and calls showNotification with the origin only', async () => {
    const emit = vi.fn();
    const notify = vi.fn(async () => {});
    notifyingSecureEmit({ emit, notify, t })(request());
    expect(emit).toHaveBeenCalledWith(request());
    expect(notify).toHaveBeenCalledTimes(1);
    const [{ title, body }] = notify.mock.calls[0] as unknown as [{ title: string; body: string }];
    expect(title).toBe('common.jr.teach.secure.notifyTitle');
    expect(body).toBe('common.jr.teach.secure.notifyBody:portal.gov.br');
  });

  it('emits before notifying, so a slow notification never delays the card', () => {
    const order: string[] = [];
    notifyingSecureEmit({
      emit: () => order.push('emit'),
      notify: async () => {
        order.push('notify');
      },
      t,
    })(request());
    expect(order).toEqual(['emit', 'notify']);
  });

  it('still emits the request when showNotification rejects', async () => {
    const emit = vi.fn();
    const notify = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(() => notifyingSecureEmit({ emit, notify, t })(request())).not.toThrow();
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('still emits the request when showNotification throws synchronously', () => {
    const emit = vi.fn();
    const notify = vi.fn(() => {
      throw new Error('boom');
    });
    expect(() => notifyingSecureEmit({ emit, notify, t })(request())).not.toThrow();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a save-only offer (no code is being asked)', () => {
    const emit = vi.fn();
    const notify = vi.fn(async () => {});
    notifyingSecureEmit({ emit, notify, t })(request({ kind: 'password', purpose: 'save-only' }));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });
});
