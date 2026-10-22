import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControlServer } from '../../../../services/control/server.mjs';
import { ADMIN_CODE, MODEL, startControl, UPSTREAM_KEY } from './support.mjs';

test('requires explicit strong owner and upstream configuration', () => {
  const valid = {
    databasePath: ':memory:',
    adminCode: ADMIN_CODE,
    upstreamKey: UPSTREAM_KEY,
    upstreamUrl: 'https://example.test/v1',
    model: MODEL,
  };
  for (const overrides of [
    { adminCode: undefined },
    { adminCode: 'default' },
    { upstreamKey: undefined },
    { upstreamUrl: 'http://example.test/v1' },
    { upstreamUrl: 'https://user:password@example.test/v1' },
    { upstreamUrl: 'https://example.test/v1?key=private' },
    { upstreamUrl: 'https://example.test/v1#private' },
    { model: 'foreign-model' },
  ]) {
    assert.throws(() => createControlServer({ ...valid, ...overrides }), /invalid_configuration/);
  }
});

test('only health and login are public', async (t) => {
  const app = await startControl(t);
  assert.deepEqual(await (await app.request('/health')).json(), { status: 'ok' });
  for (const path of ['/auth/session', '/admin/employees', '/usage', '/v1/models']) {
    assert.equal((await app.request(path)).status, 401);
  }
});

test('owner authenticates with an opaque session and cannot impersonate an employee through request input', async (t) => {
  const app = await startControl(t);
  const owner = await app.login();
  assert.equal(owner.response.status, 200);
  assert.deepEqual(owner.user, { id: 'owner', name: 'Administrador', role: 'admin' });
  assert.match(owner.token, /^[a-zA-Z0-9_-]{43}$/);
  const session = await app.request('/auth/session', { token: owner.token });
  assert.deepEqual(await session.json(), { user: owner.user });
  const invalid = await app.login('invalid-code-with-sufficient-length-to-check', 'wrong');
  assert.equal(invalid.response.status, 401);
  assert.equal(JSON.stringify(invalid).includes(ADMIN_CODE), false);
});

test('owner creates a one-use invite and employee cannot administer users', async (t) => {
  const app = await startControl(t);
  const owner = await app.login();
  const invite = await app.invite(owner.token);
  assert.equal(invite.response.status, 201);
  const employee = await app.login(invite.code, 'employee');
  assert.equal(employee.response.status, 200);
  assert.equal(employee.user.id, invite.id);
  assert.equal(employee.user.role, 'employee');
  assert.equal((await app.login(invite.code, 'second-device')).response.status, 401);
  for (const path of ['/admin/employees', '/admin/invites', `/admin/employees/${invite.id}/revoke`]) {
    assert.equal(
      (
        await app.request(path, {
          token: employee.token,
          method: path === '/admin/employees' ? 'GET' : 'POST',
          body: path === '/admin/invites' ? { name: 'Escalação', role: 'admin' } : undefined,
        })
      ).status,
      403
    );
  }
  const list = await (await app.request('/admin/employees', { token: owner.token })).json();
  assert.equal(list.employees[0].devices[0].name, 'Computador employee');
  assert.equal(JSON.stringify(list).includes(invite.code), false);
});

test('revocation immediately blocks existing sessions and unused invites without revoking the owner', async (t) => {
  const app = await startControl(t);
  const owner = await app.login();
  const first = await app.invite(owner.token, 'Primeiro');
  const employee = await app.login(first.code, 'first');
  const second = await app.invite(owner.token, 'Segundo');
  for (const id of [first.id, second.id]) {
    assert.equal(
      (await app.request(`/admin/employees/${id}/revoke`, { method: 'POST', token: owner.token })).status,
      200
    );
  }
  assert.equal((await app.request('/auth/session', { token: employee.token })).status, 401);
  assert.equal(
    (
      await app.request('/v1/chat/completions', {
        method: 'POST',
        token: employee.token,
        body: { messages: [{ role: 'user', content: 'Olá' }] },
      })
    ).status,
    401
  );
  assert.equal((await app.login(second.code, 'second')).response.status, 401);
  assert.equal(
    (await app.request('/admin/employees/owner/revoke', { method: 'POST', token: owner.token })).status,
    404
  );
  assert.equal((await app.request('/auth/session', { token: owner.token })).status, 200);
});

test('administrator can temporarily block and restore an employee without consuming a new invitation', async (t) => {
  let upstreamCalls = 0;
  const app = await startControl(t, {
    upstreamFetch: async () => {
      upstreamCalls += 1;
      return Response.json({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } });
    },
  });
  const owner = await app.login();
  const invitation = await app.invite(owner.token, 'Bloqueio temporário');
  const employee = await app.login(invitation.code, 'temporary-block');
  const block = await app.request(`/admin/employees/${invitation.id}/block`, {
    method: 'POST',
    token: owner.token,
    body: { blocked: true },
  });
  assert.equal(block.status, 200);
  assert.deepEqual(await block.json(), { blocked: true });
  for (const response of [
    await app.request('/auth/session', { token: employee.token }),
    await app.request('/v1/chat/completions', {
      method: 'POST',
      token: employee.token,
      body: { messages: [{ role: 'user', content: 'Olá' }] },
    }),
  ]) {
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: { code: 'employee_blocked' } });
  }
  assert.equal(upstreamCalls, 0);
  const listed = await (await app.request('/admin/employees', { token: owner.token })).json();
  assert.equal(listed.employees[0].blocked, true);
  assert.ok(listed.employees[0].blockedAt);
  const unblock = await app.request(`/admin/employees/${invitation.id}/block`, {
    method: 'POST',
    token: owner.token,
    body: { blocked: false },
  });
  assert.equal(unblock.status, 200);
  assert.deepEqual(await unblock.json(), { blocked: false });
  assert.equal((await app.request('/auth/session', { token: employee.token })).status, 200);
});

test('administrator can set and edit token limits and daily access hours', async (t) => {
  let timestamp = Date.parse('2026-10-22T15:00:00Z');
  const app = await startControl(t, { now: () => timestamp });
  const owner = await app.login();
  const invitation = await app.invite(owner.token, 'Horário e limite');
  const employee = await app.login(invitation.code, 'schedule-policy');
  const policy = await app.request(`/admin/employees/${invitation.id}/policy`, {
    method: 'POST',
    token: owner.token,
    body: { tokenLimit: 9000, accessStart: '13:00', accessEnd: '18:00' },
  });
  assert.equal(policy.status, 200);
  const list = await (await app.request('/admin/employees', { token: owner.token })).json();
  assert.equal(list.employees[0].tokenLimit, 9000);
  assert.equal(list.employees[0].accessStart, '13:00');
  assert.equal(list.employees[0].accessEnd, '18:00');
  assert.equal((await app.request('/auth/session', { token: employee.token })).status, 403);
  timestamp += 60 * 60_000;
  assert.equal((await app.request('/auth/session', { token: employee.token })).status, 200);
  const edited = await app.request(`/admin/employees/${invitation.id}/policy`, {
    method: 'POST',
    token: owner.token,
    body: { tokenLimit: null, accessStart: null, accessEnd: null },
  });
  assert.equal(edited.status, 200);
  const cleared = await (await app.request('/admin/employees', { token: owner.token })).json();
  assert.equal(cleared.employees[0].tokenLimit, null);
  assert.equal(cleared.employees[0].accessStart, null);
  assert.equal(cleared.employees[0].accessEnd, null);
});

test('invites expire after seven days and sessions expire after thirty days', async (t) => {
  let timestamp = Date.parse('2026-10-22T12:00:00Z');
  const app = await startControl(t, { now: () => timestamp });
  const owner = await app.login();
  const unused = await app.invite(owner.token, 'Expirado');
  const active = await app.invite(owner.token, 'Ativo');
  const employee = await app.login(active.code, 'active');
  timestamp += 7 * 86_400_000;
  assert.equal((await app.login(unused.code, 'expired')).response.status, 401);
  assert.equal((await app.request('/auth/session', { token: employee.token })).status, 200);
  timestamp += 23 * 86_400_000;
  assert.equal((await app.request('/auth/session', { token: employee.token })).status, 401);
});

test('logout invalidates only that session and login rejects unsafe input', async (t) => {
  const app = await startControl(t);
  const owner = await app.login();
  const other = await app.login(ADMIN_CODE, 'other');
  const invalid = await app.request('/auth/login', {
    method: 'POST',
    body: { code: ADMIN_CODE, deviceId: '', deviceName: 'PC' },
  });
  assert.equal(invalid.status, 400);
  assert.equal((await app.request('/auth/logout', { method: 'POST', token: owner.token })).status, 200);
  assert.equal((await app.request('/auth/session', { token: owner.token })).status, 401);
  assert.equal((await app.request('/auth/session', { token: other.token })).status, 200);
});

test('owner can reissue an invite for the same active employee without reactivating a revoked employee', async (t) => {
  const app = await startControl(t);
  const owner = await app.login();
  const first = await app.invite(owner.token);
  const renewedResponse = await app.request(`/admin/employees/${first.id}/invite`, {
    method: 'POST',
    token: owner.token,
  });
  const renewed = await renewedResponse.json();
  assert.equal(renewedResponse.status, 201);
  assert.equal(renewed.id, first.id);
  assert.equal((await app.login(first.code, 'old-invite')).response.status, 401);
  assert.equal((await app.login(renewed.code, 'renewed-invite')).user.id, first.id);
  await app.request(`/admin/employees/${first.id}/revoke`, { method: 'POST', token: owner.token });
  assert.equal(
    (await app.request(`/admin/employees/${first.id}/invite`, { method: 'POST', token: owner.token })).status,
    409
  );
});

test('a different employee binding is rejected before consuming an otherwise valid invite', async (t) => {
  const app = await startControl(t);
  const owner = await app.login();
  const invitation = await app.invite(owner.token);
  const mismatch = await app.request('/auth/login', {
    method: 'POST',
    body: {
      code: invitation.code,
      deviceId: 'device-bound-test',
      deviceName: 'Computador',
      employeeId: 'another-employee-id',
    },
  });
  assert.equal(mismatch.status, 403);
  assert.deepEqual(await mismatch.json(), { error: { code: 'device_bound_to_other_employee' } });
  assert.equal((await app.login(invitation.code, 'correct-binding')).response.status, 200);
  const ownerMismatch = await app.request('/auth/login', {
    method: 'POST',
    body: { code: ADMIN_CODE, deviceId: 'device-bound-test', deviceName: 'Computador', employeeId: invitation.id },
  });
  assert.equal(ownerMismatch.status, 403);
});

test('malformed JSON, oversized login bodies, and repeated login attempts are refused', async (t) => {
  const app = await startControl(t);
  const malformed = await fetch(`${app.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{broken',
  });
  assert.equal(malformed.status, 400);
  const oversized = await app.request('/auth/login', { method: 'POST', body: { code: 'x'.repeat(17_000) } });
  assert.equal(oversized.status, 413);
  let last;
  for (let attempt = 0; attempt < 60; attempt += 1) last = await app.login('wrong', `attempt-${attempt}`);
  assert.equal(last.response.status, 429);
});

test('service shutdown is safe to repeat', async (t) => {
  const app = await startControl(t);
  await app.close();
  await assert.doesNotReject(app.close());
});

test('database stores no raw invite, access code, session token, upstream key, or prompt', async (t) => {
  const app = await startControl(t);
  const owner = await app.login();
  const invitation = await app.invite(owner.token);
  const employee = await app.login(invitation.code, 'privacy');
  await (
    await app.request('/v1/chat/completions', {
      method: 'POST',
      token: employee.token,
      body: { messages: [{ role: 'user', content: 'private-prompt-never-store-73921' }] },
    })
  ).json();
  const files = ['control.sqlite', 'control.sqlite-wal'];
  for (const filename of files) {
    const path = join(app.directory, filename);
    const contents = await readFile(path).catch(() => Buffer.alloc(0));
    for (const value of [
      ADMIN_CODE,
      invitation.code,
      employee.token,
      UPSTREAM_KEY,
      'private-prompt-never-store-73921',
    ]) {
      assert.equal(contents.includes(Buffer.from(value)), false, `${filename} contains sensitive text`);
    }
  }
  if (process.platform !== 'win32')
    assert.equal((await stat(join(app.directory, 'control.sqlite'))).mode & 0o777, 0o600);
});
