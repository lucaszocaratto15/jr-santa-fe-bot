import { afterEach, expect, it, vi } from 'vitest';
import { createControlServer } from '../../../../services/control/server.mjs';
import { applyJrProxyDenial, JrAccessController } from '@/process/services/jr/auth';
import type { JrStoredSession } from '@/process/services/jr/auth';
import { startJrAuthProxy } from '@/process/services/jr/authProxy';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const adminCode = 'synthetic-administrator-code-1234567890';
  const service = createControlServer({
    databasePath: ':memory:',
    adminCode,
    upstreamUrl: 'https://provider.example/v1',
    upstreamKey: 'synthetic-upstream-key',
    model: 'MiniMax-M3.1-Flash',
    upstreamFetch: async () =>
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'Olá' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
  });
  await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => service.close());
  const address = service.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not start');
  const url = `http://127.0.0.1:${address.port}`;
  function client() {
    let saved: JrStoredSession | null = null;
    let proxy: Awaited<ReturnType<typeof startJrAuthProxy>> | null = null;
    const stopCore = vi.fn(async () => {
      await proxy?.close();
      proxy = null;
    });
    const controller = new JrAccessController({
      url,
      store: {
        read: async () => saved,
        write: async (value) => {
          saved = value;
        },
      },
      onChange: () => {},
      stopCore,
      configureCore: async (remote) => {
        proxy = await startJrAuthProxy(remote, (notice) => {
          applyJrProxyDenial(controller, remote.token, notice);
        });
      },
    });
    cleanup.push(async () => {
      controller.dispose();
      await stopCore();
    });
    return {
      controller,
      stopCore,
      get saved() {
        return saved;
      },
      get proxy() {
        return proxy;
      },
    };
  }
  return { adminCode, client };
}

it('authenticates real invites, meters the actual model proxy and stops the client after administrative revocation', async () => {
  const { adminCode, client } = await fixture();
  const owner = client(),
    employee = client();
  await owner.controller.initialize();
  await owner.controller.login({ code: adminCode });
  const invitation = await owner.controller.createInvite({ name: 'Ana' });
  await employee.controller.initialize();
  await employee.controller.login({ code: invitation.code });
  const local = employee.proxy!.connection;
  expect(local.token).not.toBe(employee.saved?.token);
  const response = await fetch(`${local.url}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: local.model, messages: [{ role: 'user', content: 'Olá' }] }),
  });
  expect(response.status).toBe(200);
  await response.json();
  expect((await employee.controller.personalUsage()).usage).toMatchObject({
    promptTokens: 5,
    completionTokens: 2,
    modelRequests: 1,
  });
  const listed = await owner.controller.listEmployees();
  expect(listed[0]).toMatchObject({ id: invitation.id, name: 'Ana', role: 'employee', revoked: false });
  await owner.controller.revoke({ employeeId: invitation.id });
  const denied = await fetch(`${local.url}/models`, { headers: { Authorization: `Bearer ${local.token}` } });
  expect(denied.status).toBe(401);
  expect(employee.controller.state).toEqual({ status: 'revoked', user: null });
  expect(employee.stopCore).toHaveBeenCalledOnce();
  expect(employee.saved?.token).toBeNull();
});

it('a blocked employee loses the workspace on the next gateway call and can return after unblock', async () => {
  const { adminCode, client } = await fixture();
  const owner = client(),
    employee = client();
  await owner.controller.initialize();
  await owner.controller.login({ code: adminCode });
  const invitation = await owner.controller.createInvite({ name: 'Ana' });
  await employee.controller.initialize();
  await employee.controller.login({ code: invitation.code });
  const kept = employee.saved?.token;
  await owner.controller.setBlocked({ employeeId: invitation.id, blocked: true });
  const local = employee.proxy!.connection;
  const denied = await fetch(`${local.url}/models`, { headers: { Authorization: `Bearer ${local.token}` } });
  expect(denied.status).toBe(403);
  expect(await denied.text()).toBe('');
  expect(employee.controller.state).toEqual({ status: 'blocked', user: null });
  expect(employee.saved?.token).toBe(kept);
  await owner.controller.setBlocked({ employeeId: invitation.id, blocked: false });
  expect((await employee.controller.accessStatus()).status).toBe('authenticated');
});

it('preserves an installation binding after logout and reuses only a new invite for the same employee', async () => {
  const { adminCode, client } = await fixture();
  const owner = client(),
    employee = client(),
    other = client();
  await owner.controller.initialize();
  await owner.controller.login({ code: adminCode });
  const first = await owner.controller.createInvite({ name: 'Ana' });
  await employee.controller.initialize();
  await employee.controller.login({ code: first.code });
  await employee.controller.logout();
  expect(employee.saved).toMatchObject({ ownerId: first.id, token: null });
  const different = await owner.controller.createInvite({ name: 'Bruno' });
  await expect(employee.controller.login({ code: different.code })).rejects.toThrow('JR_ACCESS_DEVICE_BOUND');
  await other.controller.initialize();
  await other.controller.login({ code: different.code });
  expect(other.controller.state.user?.name).toBe('Bruno');
  const renewed = await owner.controller.reissueInvite({ employeeId: first.id });
  await employee.controller.login({ code: renewed.code });
  expect(employee.controller.state.user?.id).toBe(first.id);
});

it('recognizes the owner as an administrator and creates an employee with an optional email', async () => {
  const { adminCode, client } = await fixture();
  const owner = client();
  await owner.controller.initialize();
  const signedIn = await owner.controller.login({ code: adminCode });
  expect(signedIn.user).toMatchObject({ id: 'owner', name: 'Administrador', role: 'admin' });
  const invitation = await owner.controller.createInvite({ name: 'Ana', email: 'ana@empresa.com' });
  const listed = await owner.controller.listEmployees();
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    id: invitation.id,
    name: 'Ana',
    email: 'ana@empresa.com',
    role: 'employee',
    revoked: false,
    blocked: false,
    tokenLimit: null,
    accessStart: null,
    accessEnd: null,
  });
  expect(invitation.code.startsWith('JR-')).toBe(true);
});

it('lists an employee created without an email and rejects a malformed email before saving', async () => {
  const { adminCode, client } = await fixture();
  const owner = client();
  await owner.controller.initialize();
  await owner.controller.login({ code: adminCode });
  const invitation = await owner.controller.createInvite({ name: 'Bruno', email: '   ' });
  expect((await owner.controller.listEmployees())[0]).toMatchObject({ id: invitation.id, email: null });
  await expect(owner.controller.createInvite({ name: 'Carlos', email: 'not-an-email' })).rejects.toThrow(
    'JR_ACCESS_INVALID_EMAIL'
  );
  expect(await owner.controller.listEmployees()).toHaveLength(1);
});

it('blocks and revokes an employee created through the control service', async () => {
  const { adminCode, client } = await fixture();
  const owner = client();
  await owner.controller.initialize();
  await owner.controller.login({ code: adminCode });
  const invitation = await owner.controller.createInvite({ name: 'Ana', email: 'ana@empresa.com' });
  await owner.controller.setBlocked({ employeeId: invitation.id, blocked: true });
  expect((await owner.controller.listEmployees())[0]).toMatchObject({
    id: invitation.id,
    blocked: true,
    revoked: false,
  });
  await owner.controller.revoke({ employeeId: invitation.id });
  expect((await owner.controller.listEmployees())[0]).toMatchObject({ id: invitation.id, revoked: true });
});
