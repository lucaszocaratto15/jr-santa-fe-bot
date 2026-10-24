import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createControlServer } from '../../../../services/control/server.mjs';
import { createStore } from '../../../../services/control/store.mjs';
import { fallbackProviders } from '../../../../services/control/validation.mjs';
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
    { openRouterKey: 'short-key' },
    { geminiKey: `bad\n${'k'.repeat(20)}` },
    { openRouterKey: 'openrouter-test-key-not-real', openRouterModels: 'openai/gpt-4o' },
    { openCodeKey: 'short-key' },
    { openCodeKey: 'opencode-test-key-not-real-xx', openCodeModels: 'minimax-m3' },
    { openCodeKey: 'opencode-test-key-not-real-xx', openCodeModels: 'jev-1.13-free' },
    { fallbackEnabled: 'maybe', openRouterKey: 'openrouter-test-key-not-real' },
  ]) {
    assert.throws(() => createControlServer({ ...valid, ...overrides }), /invalid_configuration/);
  }
  const refused = { ...valid, openRouterKey: 'openrouter-test-key-not-real', openRouterModels: 'paid/model' };
  try {
    createControlServer(refused);
    assert.fail('invalid fallback configuration was accepted');
  } catch (error) {
    assert.equal(error instanceof Error && error.message.includes(refused.openRouterKey), false);
  }
});

test('OpenCode fallback uses only the documented free chat models', () => {
  const key = 'opencode-test-key-not-real-xx';
  const chain = fallbackProviders({ openCodeKey: key });
  assert.deepEqual(
    chain.providers.map((provider) => provider.model),
    [
      'big-pickle',
      'glm-5.3-flash-free',
      'deepseek-v4.1-flash-free',
      'beam-free',
      'flint-40b-free',
      'longcat-2.5-preview-free',
      'mimo-v2.6-flash-free',
      'nemotron-3-ultra-free',
      'nemotron-3.5-lightning-free',
      'nemotron-3.5-super-vl-free',
    ]
  );
  assert.equal(
    chain.providers.every(
      (provider) =>
        provider.id === 'opencode' && provider.url === 'https://opencode.ai/inference/openai/v1/chat/completions'
    ),
    true
  );
  const subset = fallbackProviders({ openCodeKey: key, openCodeModels: 'flint-40b-free, big-pickle, big-pickle' });
  assert.deepEqual(
    subset.providers.map((provider) => provider.model),
    ['flint-40b-free', 'big-pickle']
  );
  assert.deepEqual(fallbackProviders({ openCodeModels: 'big-pickle' }).providers, []);
});

test('a paid OpenCode model is refused without revealing the key', () => {
  const key = 'opencode-test-key-not-real-xx';
  for (const models of ['minimax-m3', 'jev-1.13', 'jev-1.13-free', 'glm-5.3', 'big-pickle,openai/gpt-4o']) {
    try {
      fallbackProviders({ openCodeKey: key, openCodeModels: models });
      assert.fail(`paid or non-chat model was accepted: ${models}`);
    } catch (error) {
      const text = String(error);
      assert.equal(text.includes(key), false);
      assert.equal(text.includes(models), false);
    }
  }
});

test('fallback order is OpenRouter, then OpenCode, then Gemini', () => {
  const chain = fallbackProviders({
    openRouterKey: 'openrouter-test-key-not-real',
    openRouterModels: 'deepseek/deepseek-chat:free',
    openCodeKey: 'opencode-test-key-not-real-xx',
    openCodeModels: 'big-pickle',
    geminiKey: 'gemini-test-key-not-real-xx',
  });
  assert.deepEqual(
    chain.providers.map((provider) => `${provider.id}:${provider.model}`),
    [
      'openrouter:openrouter/free',
      'openrouter:deepseek/deepseek-chat:free',
      'opencode:big-pickle',
      'gemini:gemini-2.5-flash',
    ]
  );
  const opencodeOnly = fallbackProviders({ openCodeKey: 'opencode-test-key-not-real-xx', openCodeModels: 'beam-free' });
  assert.equal(opencodeOnly.enabled, true);
  assert.deepEqual(
    opencodeOnly.providers.map((provider) => provider.id),
    ['opencode']
  );
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
  assert.deepEqual(owner.user, { id: 'owner', name: 'Lucas Zocaratto', role: 'admin' });
  assert.match(owner.token, /^[a-zA-Z0-9_-]{43}$/);
  const session = await app.request('/auth/session', { token: owner.token });
  assert.deepEqual(await session.json(), { user: owner.user });
  const invalid = await app.login('invalid-code-with-sufficient-length-to-check', 'wrong');
  assert.equal(invalid.response.status, 401);
  assert.equal(JSON.stringify(invalid).includes(ADMIN_CODE), false);
});

test('replaces a stored role-word owner name and leaves an employee with that same word', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jr-owner-name-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'control.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  db.prepare("INSERT INTO users (id,name,role,created_at) VALUES ('owner','Administrador','admin',1)").run();
  db.prepare("INSERT INTO users (id,name,role,created_at) VALUES ('emp-1','Administrador','employee',2)").run();
  db.close();
  const store = createStore({ databasePath, adminCode: ADMIN_CODE, model: MODEL, now: () => 1_700_000_000_000 });
  t.after(() => store.close());
  const owner = store.login({ code: ADMIN_CODE, deviceId: 'device-1', deviceName: 'Desk' });
  assert.equal(owner.user.name, 'Lucas Zocaratto');
  assert.equal(store.employees().find((person) => person.id === 'emp-1').name, 'Administrador');
});

test('keeps a real owner name already stored on the account', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jr-owner-kept-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'control.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(
    'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL)'
  );
  db.prepare("INSERT INTO users (id,name,role,created_at) VALUES ('owner','Maria Souza','admin',1)").run();
  db.close();
  const store = createStore({ databasePath, adminCode: ADMIN_CODE, model: MODEL, now: () => 1_700_000_000_000 });
  t.after(() => store.close());
  const owner = store.login({ code: ADMIN_CODE, deviceId: 'device-1', deviceName: 'Desk' });
  assert.equal(owner.user.name, 'Maria Souza');
});

test('stores an optional employee email and rejects a malformed address', async (t) => {
  const app = await startControl(t);
  const owner = await app.login();
  const created = await app.request('/admin/invites', {
    method: 'POST',
    token: owner.token,
    body: { name: 'Ana', email: 'ana@empresa.com' },
  });
  assert.equal(created.status, 201);
  const invitation = await created.json();
  const withEmail = await (await app.request('/admin/employees', { token: owner.token })).json();
  assert.equal(withEmail.employees.find((person) => person.id === invitation.id).email, 'ana@empresa.com');
  const blank = await app.request('/admin/invites', {
    method: 'POST',
    token: owner.token,
    body: { name: 'Bruno', email: '   ' },
  });
  assert.equal(blank.status, 201);
  const listed = await (await app.request('/admin/employees', { token: owner.token })).json();
  assert.equal(listed.employees.find((person) => person.name === 'Bruno').email, null);
  const malformed = await app.request('/admin/invites', {
    method: 'POST',
    token: owner.token,
    body: { name: 'Carlos', email: 'not-an-email' },
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'invalid_request');
});

test('repairs an owner row whose role drifted away from administrator', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jr-owner-role-'));
  const databasePath = join(directory, 'control.sqlite');
  const open = () => createStore({ databasePath, adminCode: ADMIN_CODE, model: MODEL });
  try {
    open().close();
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE users SET role = 'employee' WHERE id = 'owner'").run();
    db.close();
    const repaired = open();
    const session = repaired.login({
      code: ADMIN_CODE,
      deviceId: 'device-owner-repair',
      deviceName: 'Computador',
    });
    assert.equal(session.user.role, 'admin');
    assert.equal(session.user.id, 'owner');
    repaired.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  const employeeId = first.id;
  for (const [method, path, body] of [
    ['GET', '/auth/session'],
    ['POST', '/auth/logout'],
    ['GET', '/usage'],
    ['GET', '/v1/models'],
    ['POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'Olá' }] }],
    ['GET', '/admin/employees'],
    ['POST', '/admin/invites', { name: 'Outro' }],
    ['POST', `/admin/employees/${employeeId}/revoke`],
    ['POST', `/admin/employees/${employeeId}/invite`],
    ['POST', `/admin/employees/${employeeId}/block`, { blocked: true }],
    ['POST', `/admin/employees/${employeeId}/policy`, { tokenLimit: null, accessStart: null, accessEnd: null }],
  ]) {
    const response = await app.request(path, { method, token: employee.token, body });
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { error: { code: 'invalid_session' } });
  }
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
  for (const [method, path, body] of [
    ['GET', '/auth/session'],
    ['POST', '/auth/logout'],
    ['GET', '/usage'],
    ['GET', '/v1/models'],
    ['POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'Olá' }] }],
    ['GET', '/admin/employees'],
    ['POST', '/admin/invites', { name: 'Outro' }],
    ['POST', `/admin/employees/${invitation.id}/revoke`],
    ['POST', `/admin/employees/${invitation.id}/invite`],
    ['POST', `/admin/employees/${invitation.id}/block`, { blocked: false }],
    ['POST', `/admin/employees/${invitation.id}/policy`, { tokenLimit: 1, accessStart: null, accessEnd: null }],
  ]) {
    const response = await app.request(path, { method, token: employee.token, body });
    assert.equal(response.status, 403, path);
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
