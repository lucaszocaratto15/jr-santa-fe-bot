import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isJrAdmin } from '@/common/config/clientSettings';
import {
  applyJrProxyDenial,
  createJrSessionStore,
  getJrControlUrl,
  JR_SESSION_CHECK_INTERVAL_MS,
  JrAccessController,
} from '@/process/services/jr/auth';
import type { JrStoredSession } from '@/process/services/jr/auth';

const url = 'https://company.example/bot';
const user = { id: 'employee-1', name: 'Ana', role: 'employee' as const };
const token = 's'.repeat(64);
const stored = { deviceId: 'device-1', issuer: url, ownerId: 'employee-1', token };
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function setup(initial: JrStoredSession | null = null) {
  let data = initial;
  const store = {
    read: vi.fn(async () => data),
    write: vi.fn(async (value: JrStoredSession) => {
      data = value;
    }),
  };
  const request = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/login')) return Response.json({ token, user });
    if (path.endsWith('/auth/session')) return Response.json({ user });
    if (path.endsWith('/v1/models')) return Response.json({ data: [{ id: 'MiniMax-M3.1-Flash' }] });
    return Response.json({});
  });
  const configureCore = vi.fn(async () => {});
  const stopCore = vi.fn(async () => {});
  const onChange = vi.fn();
  const controller = new JrAccessController({ url, store, request, configureCore, stopCore, onChange });
  return { controller, store, request, configureCore, stopCore, onChange };
}

describe('company access configuration', () => {
  it('uses the branded service and never accepts embedded credentials or query strings', () => {
    expect(getJrControlUrl({})).toBe('https://jrsantafe.stratacerta.com.br/bot');
    expect(getJrControlUrl({ JR_CONTROL_URL: '' })).toBeNull();
    expect(getJrControlUrl({ JR_CONTROL_URL: url + '/' })).toBe(url);
    for (const candidate of [
      'http://company.example/bot',
      'https://user:password@company.example/bot',
      url + '?token=secret',
    ]) {
      expect(() => getJrControlUrl({ JR_CONTROL_URL: candidate })).toThrow();
    }
  });

  it('allows loopback HTTP only with the explicit local control test flag', () => {
    expect(() => getJrControlUrl({ JR_CONTROL_URL: 'http://127.0.0.1:4555' })).toThrow();
    expect(getJrControlUrl({ JR_CONTROL_URL: 'http://127.0.0.1:4555', JR_ALLOW_INSECURE_CONTROL_TEST: '1' })).toBe(
      'http://127.0.0.1:4555'
    );
  });
});

describe('company access state', () => {
  it('opens the local core only after server authentication, model verification and encrypted persistence', async () => {
    const { controller, configureCore, store } = setup();
    await controller.initialize();
    expect(controller.state.status).toBe('signed-out');
    await controller.login({ code: 'a-company-invite' });
    expect(controller.state).toEqual({ status: 'authenticated', user });
    expect(configureCore).toHaveBeenCalledWith({ url: url + '/v1', token, model: 'MiniMax-M3.1-Flash' });
    expect(JSON.stringify(controller.state)).not.toContain(token);
    expect(store.write).toHaveBeenCalledWith(expect.objectContaining({ issuer: url, ownerId: user.id, token }));
  });

  it('opens the next launch already signed in from the encrypted session and does not ask for the invite again', async () => {
    const first = setup();
    await first.controller.initialize();
    await first.controller.login({ code: 'a-company-invite' });
    const saved = first.store.write.mock.calls.at(-1)?.[0];
    expect(saved?.token).toBe(token);
    const second = setup(saved);
    await second.controller.initialize();
    expect(second.controller.state).toEqual({ status: 'authenticated', user });
    expect(second.request.mock.calls.some((call) => String(call[0]).endsWith('/auth/login'))).toBe(false);
    expect(second.configureCore).toHaveBeenCalledWith({ url: url + '/v1', token, model: 'MiniMax-M3.1-Flash' });
    expect(JSON.stringify(second.controller.state)).not.toContain(token);
  });

  it('keeps the administrator role when session.enc restores an admin', async () => {
    const admin = { id: 'owner', name: 'Lucas', role: 'admin' as const };
    const saved = { deviceId: 'device-1', issuer: url, ownerId: 'owner', token };
    const { controller, request } = setup(saved);
    request.mockImplementation(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/auth/session')) return Response.json({ user: admin });
      if (path.endsWith('/v1/models')) return Response.json({ data: [{ id: 'MiniMax-M3.1-Flash' }] });
      return Response.json({});
    });
    await controller.initialize();
    expect(controller.state).toEqual({ status: 'authenticated', user: admin });
    expect(isJrAdmin(controller.state.user)).toBe(true);
    expect(request.mock.calls.some((call) => String(call[0]).endsWith('/auth/login'))).toBe(false);
  });

  it('still treats the owner as an administrator when the restored role label drifted', async () => {
    const saved = { deviceId: 'device-1', issuer: url, ownerId: 'owner', token };
    const { controller, request } = setup(saved);
    request.mockImplementation(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/auth/session'))
        return Response.json({ user: { id: 'owner', name: 'Lucas', role: 'Administrador' } });
      if (path.endsWith('/v1/models')) return Response.json({ data: [{ id: 'MiniMax-M3.1-Flash' }] });
      return Response.json({});
    });
    await controller.initialize();
    expect(controller.state.user).toEqual({ id: 'owner', name: 'Lucas', role: 'admin' });
    expect(isJrAdmin(controller.state.user)).toBe(true);
  });

  it('registers the gateway again when a restored session retries the connection', async () => {
    const { controller, configureCore } = setup(stored);
    await controller.initialize();
    configureCore.mockClear();
    await controller.ensureGateway();
    expect(configureCore).toHaveBeenCalledWith({ url: url + '/v1', token, model: 'MiniMax-M3.1-Flash' });
  });

  it('does not register the gateway when nobody is signed in', async () => {
    const { controller, configureCore } = setup();
    await controller.initialize();
    await expect(controller.ensureGateway()).rejects.toThrow('JR_ACCESS_REQUIRED');
    expect(configureCore).not.toHaveBeenCalled();
  });

  it('rejects a revoked session during startup before the local agent starts and clears the stored token', async () => {
    const { controller, request, configureCore, store } = setup(stored);
    request.mockImplementation(async (input: string | URL | Request) => {
      if (String(input).endsWith('/auth/session')) return new Response(null, { status: 401 });
      return Response.json({ data: [{ id: 'MiniMax-M3.1-Flash' }] });
    });
    await controller.initialize();
    expect(controller.state).toEqual({ status: 'revoked', user: null });
    expect(configureCore).not.toHaveBeenCalled();
    expect(store.write).toHaveBeenLastCalledWith({ ...stored, token: null });
  });

  it('rechecks the stored session once a minute and clears it when that check is revoked', async () => {
    const { controller, request, store } = setup(stored);
    await controller.initialize();
    let tick: (() => void) | undefined;
    const timer = setInterval(() => {}, 60_000);
    timer.unref();
    const interval = vi.spyOn(global, 'setInterval').mockImplementation(((handler: () => void, ms?: number) => {
      expect(ms).toBe(JR_SESSION_CHECK_INTERVAL_MS);
      tick = handler;
      return timer;
    }) as typeof setInterval);
    request.mockClear();
    controller.startHeartbeat();
    interval.mockRestore();
    expect(tick).toEqual(expect.any(Function));
    request.mockResolvedValueOnce(new Response(null, { status: 401 }));
    tick?.();
    await vi.waitFor(() => expect(controller.state.status).toBe('revoked'));
    expect(String(request.mock.calls[0]?.[0])).toContain('/auth/session');
    expect(store.write).toHaveBeenLastCalledWith({ ...stored, token: null });
    controller.dispose();
  });

  it('drops the encrypted token when a gateway response says the session was revoked', async () => {
    const { controller, store, stopCore } = setup(stored);
    await controller.initialize();
    applyJrProxyDenial(controller, 'not-the-saved-token', { status: 401, code: 'invalid_session' });
    await Promise.resolve();
    expect(controller.state.status).toBe('authenticated');
    applyJrProxyDenial(controller, token, { status: 401, code: 'invalid_session' });
    await vi.waitFor(() => expect(store.write).toHaveBeenLastCalledWith({ ...stored, token: null }));
    expect(controller.state.status).toBe('revoked');
    expect(stopCore).toHaveBeenCalledOnce();
  });

  it('hides the workspace when a gateway response says the employee is blocked and keeps the token', async () => {
    const { controller, store, stopCore } = setup(stored);
    await controller.initialize();
    applyJrProxyDenial(controller, token, { status: 403, code: 'forbidden' });
    await Promise.resolve();
    expect(controller.state.status).toBe('authenticated');
    expect(store.write).not.toHaveBeenCalled();
    applyJrProxyDenial(controller, token, { status: 403, code: 'employee_blocked' });
    await vi.waitFor(() => expect(stopCore).toHaveBeenCalledOnce());
    expect(controller.state.status).toBe('blocked');
    expect(store.write).not.toHaveBeenCalled();
  });

  it('revocation stops all local tasks, clears the token and preserves the installation binding', async () => {
    const { controller, request, stopCore, store } = setup(stored);
    await controller.initialize();
    request.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await controller.refresh();
    expect(controller.state).toEqual({ status: 'revoked', user: null });
    expect(stopCore).toHaveBeenCalledOnce();
    expect(store.write).toHaveBeenLastCalledWith({ ...stored, token: null });
  });

  it('network failure blocks access and stops the core without discarding the recoverable session', async () => {
    const { controller, request, stopCore, store } = setup(stored);
    await controller.initialize();
    request.mockRejectedValueOnce(new Error('network failed'));
    await controller.refresh();
    expect(controller.state).toEqual({ status: 'offline', user: null });
    expect(stopCore).toHaveBeenCalledOnce();
    expect(store.write).not.toHaveBeenCalled();
  });

  it('blocks the app and local agent when the administrator blocks an employee, then restores access after unblock', async () => {
    const { controller, request, stopCore, configureCore, store } = setup(stored);
    request.mockResolvedValueOnce(Response.json({ error: { code: 'employee_blocked' } }, { status: 403 }));
    await controller.initialize();
    expect(controller.state).toEqual({ status: 'blocked', user: null });
    expect(stopCore).toHaveBeenCalledOnce();
    expect(configureCore).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();

    request.mockResolvedValueOnce(Response.json({ user }));
    request.mockResolvedValueOnce(Response.json({ data: [{ id: 'MiniMax-M3.1-Flash' }] }));
    await controller.accessStatus();
    expect(controller.state).toEqual({ status: 'authenticated', user });
    expect(configureCore).toHaveBeenCalledWith({ url: url + '/v1', token, model: 'MiniMax-M3.1-Flash' });
  });

  it('rejects a different employee before configuring the core and sends the original binding to the server', async () => {
    const { controller, request, configureCore } = setup({ ...stored, token: null });
    await controller.initialize();
    request.mockResolvedValueOnce(Response.json({ token, user: { ...user, id: 'employee-2' } }));
    await expect(controller.login({ code: 'a-company-invite' })).rejects.toThrow('JR_ACCESS_DEVICE_BOUND');
    expect(configureCore).not.toHaveBeenCalled();
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).employeeId).toBe('employee-1');
  });

  it('rejects a cached token belonging to a different issuer without sending it to that service', async () => {
    const { controller, request } = setup({ ...stored, issuer: 'https://other.example/bot' });
    await controller.initialize();
    expect(controller.state.status).toBe('unconfigured');
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses administrative operations for employees before making a request', async () => {
    const { controller, request } = setup(stored);
    await controller.initialize();
    request.mockClear();
    await expect(controller.listEmployees()).rejects.toThrow('JR_ACCESS_FORBIDDEN');
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps logout blocked locally even when the remote logout endpoint is unreachable', async () => {
    const { controller, request, stopCore, store } = setup(stored);
    await controller.initialize();
    request.mockRejectedValueOnce(new Error('offline'));
    await controller.logout();
    expect(controller.state.status).toBe('signed-out');
    expect(stopCore).toHaveBeenCalledOnce();
    expect(store.write).toHaveBeenLastCalledWith({ ...stored, token: null });
  });

  it('never starts the core if session persistence fails', async () => {
    const { controller, store, configureCore } = setup();
    await controller.initialize();
    store.write.mockRejectedValue(new Error('disk full'));
    await expect(controller.login({ code: 'a-company-invite' })).rejects.toThrow();
    expect(configureCore).not.toHaveBeenCalled();
    expect(controller.state.status).not.toBe('authenticated');
  });
});

describe('encrypted session store', () => {
  it('writes only encrypted data with private directory and file permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jr-access-'));
    roots.push(root);
    const encryption = {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(text.split('').reverse().join('')),
      decryptString: (buffer: Buffer) => buffer.toString().split('').reverse().join(''),
    };
    const store = createJrSessionStore(root, encryption);
    await store.write(stored);
    const bytes = await readFile(join(root, 'jr-access', 'session.enc'));
    expect(bytes.toString()).not.toContain(user.id);
    expect(await store.read()).toEqual(stored);
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'jr-access'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, 'jr-access', 'session.enc'))).mode & 0o777).toBe(0o600);
    }
  });

  it('stays signed out when encryption is missing at startup and signs in after it becomes available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jr-access-'));
    roots.push(root);
    let available = false;
    const diagnostics: string[] = [];
    const request = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/auth/login')) return Response.json({ token, user });
      if (path.endsWith('/v1/models')) return Response.json({ data: [{ id: 'MiniMax-M3.1-Flash' }] });
      return Response.json({});
    });
    const configureCore = vi.fn(async () => {});
    const controller = new JrAccessController({
      url,
      request,
      configureCore,
      stopCore: async () => {},
      onChange: () => {},
      onDiagnostic: (cause) => diagnostics.push(cause),
      store: createJrSessionStore(root, {
        isEncryptionAvailable: () => available,
        encryptString: (text: string) => Buffer.from(text),
        decryptString: (buffer: Buffer) => buffer.toString(),
      }),
    });
    await controller.initialize();
    expect(controller.state).toEqual({ status: 'signed-out', user: null, notice: 'storage' });
    expect(diagnostics).toEqual(['JR_ACCESS_STORAGE_UNAVAILABLE']);
    await expect(controller.login({ code: 'a-company-invite' })).rejects.toThrow('JR_ACCESS_STORAGE_UNAVAILABLE');
    expect(request).not.toHaveBeenCalled();
    expect(controller.state.status).toBe('signed-out');
    available = true;
    await controller.login({ code: 'a-company-invite' });
    expect(controller.state).toEqual({ status: 'authenticated', user });
    expect(String(request.mock.calls[0]?.[0])).toContain('/auth/login');
    expect(diagnostics.join('\n')).not.toContain(token);
    expect(diagnostics.join('\n')).not.toContain('a-company-invite');
  });

  it('retries storage from the status check and keeps a missing service address unconfigured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jr-access-'));
    roots.push(root);
    let available = false;
    const diagnostics: string[] = [];
    const controller = new JrAccessController({
      url,
      request: vi.fn(),
      configureCore: vi.fn(),
      stopCore: async () => {},
      onChange: () => {},
      onDiagnostic: (cause) => diagnostics.push(cause),
      store: createJrSessionStore(root, {
        isEncryptionAvailable: () => available,
        encryptString: (text: string) => Buffer.from(text),
        decryptString: (buffer: Buffer) => buffer.toString(),
      }),
    });
    await controller.initialize();
    available = true;
    expect(await controller.accessStatus()).toEqual({ status: 'signed-out', user: null });
    const missing = new JrAccessController({
      url: null,
      request: vi.fn(),
      configureCore: vi.fn(),
      stopCore: async () => {},
      onChange: () => {},
      onDiagnostic: (cause) => diagnostics.push(cause),
      store: { read: async () => null, write: vi.fn() },
    });
    await missing.initialize();
    expect(missing.state.status).toBe('unconfigured');
    await expect(missing.login({ code: 'a-company-invite' })).rejects.toThrow('JR_ACCESS_UNCONFIGURED');
    expect(diagnostics).toContain('JR_ACCESS_UNCONFIGURED url');
    expect(diagnostics).not.toContain('JR_ACCESS_UNCONFIGURED issuer');
    const foreign = 'https://other.example/bot';
    const mismatched = new JrAccessController({
      url,
      request: vi.fn(),
      configureCore: vi.fn(),
      stopCore: async () => {},
      onChange: () => {},
      onDiagnostic: (cause) => diagnostics.push(cause),
      store: { read: async () => ({ ...stored, issuer: foreign }), write: vi.fn() },
    });
    await mismatched.initialize();
    expect(mismatched.state.status).toBe('unconfigured');
    await expect(mismatched.login({ code: 'a-company-invite' })).rejects.toThrow('JR_ACCESS_UNCONFIGURED');
    expect(diagnostics).toContain('JR_ACCESS_UNCONFIGURED issuer');
    expect(diagnostics.join('\n')).not.toContain(foreign);
  });

  it('fails closed when operating system encryption is unavailable or Linux uses the plaintext backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jr-access-'));
    roots.push(root);
    for (const selected of ['unavailable', 'basic_text']) {
      const store = createJrSessionStore(root, {
        isEncryptionAvailable: () => selected !== 'unavailable',
        getSelectedStorageBackend: () => selected,
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      });
      await expect(store.write(stored)).rejects.toThrow('JR_ACCESS_STORAGE_UNAVAILABLE');
      await expect(store.read()).rejects.toThrow('JR_ACCESS_STORAGE_UNAVAILABLE');
    }
  });
});

it('refuses to bind an existing unowned profile before consuming an invitation', async () => {
  const request = vi.fn();
  const configureCore = vi.fn();
  const controller = new JrAccessController({
    url,
    request,
    configureCore,
    store: { read: async () => null, write: vi.fn() },
    stopCore: async () => {},
    onChange: () => {},
    beforeFirstLogin: async () => {
      throw new Error('JR_ACCESS_PROFILE_UNBOUND');
    },
  });
  await controller.initialize();
  await expect(controller.login({ code: 'a-company-invite' })).rejects.toThrow('JR_ACCESS_PROFILE_UNBOUND');
  expect(request).not.toHaveBeenCalled();
  expect(configureCore).not.toHaveBeenCalled();
});

it('does not restore access when a session check finishes after logout', async () => {
  const { controller, request, configureCore } = setup(stored);
  await controller.initialize();
  configureCore.mockClear();
  let release: (value: Response) => void = () => {};
  request.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })
  );
  const pending = controller.refresh();
  await controller.logout();
  release(Response.json({ user }));
  await pending;
  expect(controller.state.status).toBe('signed-out');
  expect(configureCore).not.toHaveBeenCalled();
});

it('does not start the core when logout arrives while a login is being persisted', async () => {
  const { controller, request, store, configureCore } = setup();
  await controller.initialize();
  let release: () => void = () => {};
  let persistenceStarted: () => void = () => {};
  const writing = new Promise<void>((resolve) => {
    persistenceStarted = resolve;
  });
  store.write.mockImplementationOnce(() => {
    persistenceStarted();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const login = controller.login({ code: 'a-company-invite' }).catch((error: unknown) => error);
  await writing;
  const logout = controller.logout();
  release();
  await Promise.all([login, logout]);
  expect(controller.state.status).toBe('signed-out');
  expect(configureCore).not.toHaveBeenCalled();
  expect(store.write).toHaveBeenLastCalledWith(expect.objectContaining({ ownerId: user.id, token: null }));
  expect(request.mock.calls.some((call) => String(call[0]).endsWith('/auth/logout'))).toBe(true);
});

it('keeps unknown provider counters unknown while reporting measured requests and latency', async () => {
  const { controller, request } = setup(stored);
  await controller.initialize();
  request.mockResolvedValueOnce(
    Response.json({
      model: 'MiniMax-M3.1-Flash',
      usage: {
        startedAt: '2026-10-22T15:00:00Z',
        promptTokens: null,
        completionTokens: null,
        cachedPromptTokens: null,
        modelRequests: 1,
        requests: 1,
        completedRequests: 1,
        meteredRequests: 0,
        unmeteredRequests: 1,
        averageLatencyMs: 532,
        averageFirstByteMs: 140,
        lastRequestAt: '2026-10-22T15:00:00Z',
      },
    })
  );
  const value = await controller.personalUsage();
  expect(value.usage).toMatchObject({
    promptTokens: null,
    completionTokens: null,
    modelRequests: 1,
    averageLatencyMs: 532,
  });
  expect(JSON.stringify(value)).not.toContain(token);
});

it('returns only validated public employee fields to the administrator', async () => {
  const { controller, request } = setup(stored);
  request.mockResolvedValueOnce(Response.json({ user: { ...user, role: 'admin' } }));
  await controller.initialize();
  request.mockResolvedValueOnce(
    Response.json({
      employees: [
        {
          ...user,
          createdAt: '2026-10-22T15:00:00Z',
          revoked: false,
          revokedAt: null,
          devices: [
            {
              id: 'device-123',
              name: 'Computador',
              lastSeenAt: '2026-10-22T15:00:00Z',
              expiresAt: '2026-11-22T15:00:00Z',
              revokedAt: null,
              secret: token,
            },
          ],
          usage: null,
          sessionToken: token,
        },
      ],
    })
  );
  const employees = await controller.listEmployees();
  expect(employees[0]).toMatchObject({ id: user.id, role: 'employee', revokedAt: null, usage: null });
  expect(JSON.stringify(employees)).not.toContain(token);
});

it('clears saved access and remotely logs out even when local process cleanup fails', async () => {
  const { controller, stopCore, store, request } = setup(stored);
  await controller.initialize();
  stopCore.mockRejectedValueOnce(new Error('process cleanup failed'));
  await expect(controller.logout()).rejects.toThrow('JR_ACCESS_RUNTIME_UNAVAILABLE');
  expect(store.write).toHaveBeenLastCalledWith({ ...stored, token: null });
  expect(request.mock.calls.some((call) => String(call[0]).endsWith('/auth/logout'))).toBe(true);
});

it('retries an offline session immediately when access status is requested', async () => {
  const { controller, request, configureCore } = setup(stored);
  await controller.initialize();
  request.mockRejectedValueOnce(new Error('offline'));
  await controller.refresh();
  const value = await controller.accessStatus();
  expect(value).toEqual({ status: 'authenticated', user });
  expect(configureCore).toHaveBeenCalledTimes(2);
});

it('preserves the revoked notice when access status is read', async () => {
  const { controller, request } = setup(stored);
  await controller.initialize();
  await controller.rejectSession();
  request.mockClear();
  expect(await controller.accessStatus()).toEqual({ status: 'revoked', user: null });
  expect(request).not.toHaveBeenCalled();
});

it.each(['logout', 'rejectSession'] as const)(
  'rejects another login until %s finishes stopping and clearing the original session',
  async (action) => {
    const { controller, stopCore, store } = setup(stored);
    await controller.initialize();
    let release = () => {};
    stopCore.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const closing = controller[action]();
    const result = await controller.login({ code: 'new-code' }).catch((error: Error) => error.message);
    release();
    await closing;
    expect(result).toBe('JR_ACCESS_BUSY');
    expect(controller.state.status).toBe(action === 'logout' ? 'signed-out' : 'revoked');
    expect(store.write).toHaveBeenLastCalledWith(expect.objectContaining({ token: null }));
  }
);

it('does not restore access when response JSON arrives after a concurrent logout', async () => {
  const { controller, request, configureCore } = setup(stored);
  await controller.initialize();
  configureCore.mockClear();
  let release = (value: unknown) => {};
  let reading = () => {};
  const bodyStarted = new Promise<void>((resolve) => {
    reading = resolve;
  });
  request.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => {
      reading();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  } as Response);
  const pending = controller.refresh();
  await bodyStarted;
  await controller.logout();
  release({ user });
  await pending;
  expect(controller.state.status).toBe('signed-out');
  expect(configureCore).not.toHaveBeenCalled();
});
