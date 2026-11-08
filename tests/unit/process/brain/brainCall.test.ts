import { describe, expect, it, vi } from 'vitest';
import { JrAccessController } from '@/process/services/jr/auth';
import { createBrainClient } from '@/process/services/jr/brainClient';

const url = 'https://company.example/bot';
const token = 's'.repeat(64);
const employee = { id: 'employee-1', name: 'Ana', role: 'employee' };

/** Controller whose control service hangs (times out) on every `/api/brain/*` and `/handbook/*` path. */
function hungBrainController(strataResponse?: (path: string) => Response) {
  let data: { deviceId: string; issuer: string; ownerId: string; token: string } | null = null;
  const store = {
    read: vi.fn(async () => data),
    write: vi.fn(async (value: typeof data) => {
      data = value;
    }),
  };
  const request = vi.fn(async (input: string | URL | Request) => {
    const path = String(input).slice(url.length);
    if (path.startsWith('/strata/')) {
      if (strataResponse) return strataResponse(path);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
    if (path.startsWith('/api/brain/') || path.startsWith('/handbook/'))
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if (path === '/auth/login') return Response.json({ token, user: employee });
    if (path === '/auth/session') return Response.json({ user: employee });
    if (path === '/v1/models') return Response.json({ data: [{ id: 'MiniMax-M3.1-Flash' }] });
    return Response.json({});
  });
  const stopCore = vi.fn(async () => {});
  const controller = new JrAccessController({
    url,
    store,
    request,
    configureCore: vi.fn(async () => {}),
    stopCore,
    onChange: vi.fn(),
  });
  return { controller, stopCore, request };
}

describe('JrAccessController.brainCall', () => {
  it('allows explicit proposal generation its bounded curator deadline without changing other calls', async () => {
    const { controller } = hungBrainController();
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await expect(controller.brainCall('/api/brain/proposals', { method: 'POST', body: '{}' })).rejects.toThrow(
        'JR_ACCESS_UNAVAILABLE'
      );
      expect(timeout).toHaveBeenCalledWith(70_000);
      timeout.mockClear();
      await expect(controller.brainCall('/api/brain/search', { method: 'POST', body: '{}' })).rejects.toThrow(
        'JR_ACCESS_UNAVAILABLE'
      );
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });
  it('a brain search timeout fails only that call and leaves access status alone', async () => {
    const { controller, stopCore } = hungBrainController();
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    expect(controller.state.status).toBe('authenticated');
    const client = createBrainClient((path, init, admin) => controller.brainCall(path, init, admin));
    await expect(client.search('frota')).rejects.toThrow('JR_ACCESS_UNAVAILABLE');
    expect(controller.state.status).toBe('authenticated');
    expect(stopCore).not.toHaveBeenCalled();
  });

  it('other control calls still go offline on a timeout (unchanged behaviour)', async () => {
    const { controller, stopCore } = hungBrainController();
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    await expect(controller.call('/handbook/mine')).rejects.toThrow('JR_ACCESS_UNAVAILABLE');
    expect(controller.state.status).toBe('offline');
    expect(stopCore).toHaveBeenCalled();
  });

  it('only accepts /api/brain/ paths', async () => {
    const { controller } = hungBrainController();
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    await expect(controller.brainCall('/handbook/mine')).rejects.toThrow('JR_ACCESS_INVALID_REQUEST');
    await expect(controller.brainCall('/api/brain/../admin/employees')).rejects.toThrow('JR_ACCESS_INVALID_REQUEST');
  });
});

describe('JrAccessController.strataCall', () => {
  it('accepts only the six authenticated Strata routes', async () => {
    const { controller, request } = hungBrainController(() => Response.json({ ok: true }));
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    for (const path of ['status', 'connect', 'organization', 'disconnect', 'mcp/tools', 'mcp/call']) {
      await expect(controller.strataCall(`/strata/${path}`)).resolves.toEqual({ ok: true });
    }
    request.mockClear();
    for (const path of [
      '/strata/callback',
      '/strata/status?user=other',
      '/strata/status/extra',
      '/strata/../admin/employees',
      '/handbook/mine',
      'https://other.example/strata/status',
    ]) {
      await expect(controller.strataCall(path)).rejects.toThrow('JR_ACCESS_INVALID_REQUEST');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps the JR login when the ERP requires reconnecting', async () => {
    const { controller, stopCore } = hungBrainController(() =>
      Response.json({ error: { code: 'strata_reconnect_required' } }, { status: 403 })
    );
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    await expect(controller.strataCall('/strata/status')).rejects.toMatchObject({
      message: 'strata_reconnect_required',
      status: 403,
    });
    expect(controller.state.status).toBe('authenticated');
    expect(stopCore).not.toHaveBeenCalled();
  });

  it('reports a changed ERP link without treating the employee as revoked', async () => {
    const { controller, stopCore } = hungBrainController(() =>
      Response.json({ error: { code: 'strata_link_changed' } }, { status: 409 })
    );
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    await expect(controller.strataCall('/strata/mcp/call')).rejects.toMatchObject({
      message: 'strata_link_changed',
      status: 409,
    });
    expect(controller.state.status).toBe('authenticated');
    expect(stopCore).not.toHaveBeenCalled();
  });

  it('a Strata timeout fails only that call and leaves JR authenticated', async () => {
    const { controller, stopCore } = hungBrainController();
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    await expect(controller.strataCall('/strata/mcp/tools')).rejects.toThrow('JR_ACCESS_UNAVAILABLE');
    expect(controller.state.status).toBe('authenticated');
    expect(stopCore).not.toHaveBeenCalled();
  });
});
