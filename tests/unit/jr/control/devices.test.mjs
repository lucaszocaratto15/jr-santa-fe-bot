import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createStore } from '../../../../services/control/store.mjs';
import { ADMIN_CODE, startControl } from './support.mjs';

async function setup(t, options) {
  const app = await startControl(t, options);
  const admin = (await app.login()).token;
  const employee = await app.invite(admin);
  const renew = async () =>
    (await (await app.request(`/admin/employees/${employee.id}/invite`, { method: 'POST', token: admin })).json()).code;
  const loginAs = async (suffix, code) => (await app.login(code ?? (await renew()), suffix)).token;
  const status = async (token) => app.request('/auth/session', { token });
  return { app, admin, employee, renew, loginAs, status, firstCode: employee.code };
}

test('employee with max 1 logging in on a second PC evicts the first', async (t) => {
  const s = await setup(t);
  const a = await s.loginAs('aaaaaaaa', s.firstCode);
  const b = await s.loginAs('bbbbbbbb');
  const old = await s.status(a);
  assert.equal(old.status, 401);
  assert.deepEqual(await old.json(), { error: { code: 'session_replaced' } });
  assert.equal((await s.status(b)).status, 200);
});

test('same PC logging in again does not evict the other PC', async (t) => {
  const s = await setup(t);
  const policy = await s.app.request(`/admin/employees/${s.employee.id}/policy`, {
    method: 'POST',
    token: s.admin,
    body: { maxDevices: 2 },
  });
  assert.equal(policy.status, 200);
  const a = await s.loginAs('aaaaaaaa', s.firstCode);
  const b = await s.loginAs('bbbbbbbb');
  const a2 = await s.loginAs('aaaaaaaa');
  assert.equal((await s.status(b)).status, 200);
  assert.equal((await s.status(a)).status, 401);
  assert.equal((await s.status(a2)).status, 200);
});

test('eviction picks the least recently seen PC', async (t) => {
  let clock = 1_800_000_000_000;
  const s = await setup(t, { now: () => clock });
  await s.app.request(`/admin/employees/${s.employee.id}/policy`, {
    method: 'POST',
    token: s.admin,
    body: { maxDevices: 2 },
  });
  const a = await s.loginAs('aaaaaaaa', s.firstCode);
  clock += 1000;
  const b = await s.loginAs('bbbbbbbb');
  clock += 1000;
  assert.equal((await s.status(a)).status, 200);
  clock += 1000;
  const c = await s.loginAs('cccccccc');
  assert.equal((await s.status(b)).status, 401);
  assert.equal((await s.status(a)).status, 200);
  assert.equal((await s.status(c)).status, 200);
});

test('admin owner is never limited', async (t) => {
  const app = await startControl(t);
  const tokens = [];
  for (const suffix of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) tokens.push((await app.login(ADMIN_CODE, suffix)).token);
  for (const token of tokens) assert.equal((await app.request('/auth/session', { token })).status, 200);
});

test('disconnect revokes only that device', async (t) => {
  const s = await setup(t);
  await s.app.request(`/admin/employees/${s.employee.id}/policy`, {
    method: 'POST',
    token: s.admin,
    body: { maxDevices: 2 },
  });
  const a = await s.loginAs('aaaaaaaa', s.firstCode);
  const b = await s.loginAs('bbbbbbbb');
  const response = await s.app.request(`/admin/employees/${s.employee.id}/devices/device-test-aaaaaaaa/disconnect`, {
    method: 'POST',
    token: s.admin,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { disconnected: true });
  const gone = await s.status(a);
  assert.equal(gone.status, 401);
  assert.deepEqual(await gone.json(), { error: { code: 'invalid_session' } });
  assert.equal((await s.status(b)).status, 200);
});

test('migration gives Bruno Yanes two PCs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jr-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'control.sqlite');
  const old = new DatabaseSync(databasePath);
  old.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
      created_at INTEGER NOT NULL, revoked_at INTEGER, blocked_at INTEGER, token_limit INTEGER, access_start TEXT, access_end TEXT);
    CREATE TABLE sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
    INSERT INTO users (id,name,role,created_at) VALUES ('u1','Bruno Yanes','employee',1),('u2','Outra Pessoa','employee',2);
  `);
  old.close();
  const store = createStore({ databasePath, adminCode: ADMIN_CODE, model: 'm' });
  const rows = Object.fromEntries(store.employees().map((e) => [e.name, e.maxDevices]));
  store.close();
  assert.deepEqual(rows, { 'Bruno Yanes': 2, 'Outra Pessoa': 1 });
});

test('evicted in-flight request is aborted', async (t) => {
  const s = await setup(t, {
    upstreamFetch: (_url, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  });
  const a = await s.loginAs('aaaaaaaa', s.firstCode);
  const inflight = s.app
    .request('/v1/chat/completions', {
      method: 'POST',
      token: a,
      body: { model: 'MiniMax-M3.1-Flash', messages: [{ role: 'user', content: 'oi' }] },
    })
    .then((r) => r.status)
    .catch(() => 'closed');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await s.loginAs('bbbbbbbb');
  const result = await Promise.race([inflight, new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000))]);
  assert.notEqual(result, 'timeout');
  assert.notEqual(result, 200);
});

async function handoverSetup(t, { revoke, firstDevice = 'pc1' }) {
  const app = await startControl(t);
  const admin = (await app.login()).token;
  const a = await app.invite(admin, 'Funcionário A');
  const b = await app.invite(admin, 'Funcionário B');
  const loginOn = async (code, device, employeeId) =>
    app.request('/auth/login', {
      method: 'POST',
      body: { code, deviceId: `device-test-${device}`, deviceName: device, ...(employeeId ? { employeeId } : {}) },
    });
  assert.equal((await loginOn(a.code, firstDevice)).status, 200);
  if (revoke) {
    assert.equal((await app.request(`/admin/employees/${a.id}/revoke`, { method: 'POST', token: admin })).status, 200);
  }
  return { loginOn, a, b };
}

test('PC passes to a new employee after the old one is revoked', async (t) => {
  const s = await handoverSetup(t, { revoke: true });
  const response = await s.loginOn(s.b.code, 'pc1', s.a.id);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.handover, true);
  assert.equal(body.user.id, s.b.id);
});

test('PC still bound while the old owner is active', async (t) => {
  const s = await handoverSetup(t, { revoke: false });
  const response = await s.loginOn(s.b.code, 'pc1', s.a.id);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: { code: 'device_bound_to_other_employee' } });
});

test('revoked employee who never used this PC cannot be claimed', async (t) => {
  const s = await handoverSetup(t, { revoke: true, firstDevice: 'pc9' });
  const response = await s.loginOn(s.b.code, 'pc1', s.a.id);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: { code: 'device_bound_to_other_employee' } });
});
