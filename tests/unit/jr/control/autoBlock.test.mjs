import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  DENIAL_EPISODE_MS,
  HOURS_DENIALS_LIMIT,
  VOLUME_FLOOR_TOKENS,
  VOLUME_MULTIPLIER,
  volumeThreshold,
} from '../../../../services/control/autoBlock.mjs';
import { createStore } from '../../../../services/control/store.mjs';
import { ADMIN_CODE, startControl } from './support.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-10-29 00:30 in São Paulo: outside an 08:00-18:00 policy.
const NIGHT = Date.parse('2026-10-29T03:30:00Z');
// 2026-10-29 10:00 in São Paulo: inside the same policy.
const WORKDAY = Date.parse('2026-10-29T13:00:00Z');

const employeeRow = async (app, admin, id) =>
  (await (await app.request('/admin/employees', { token: admin })).json()).employees.find((e) => e.id === id);

/** Insert finished requests straight into the database, as past usage. */
function seedRequests(path, rows) {
  const db = new DatabaseSync(path);
  const insert = db.prepare(
    "INSERT INTO requests (id,user_id,started_at,finished_at,status,prompt_tokens,completion_tokens) VALUES (?,?,?,?,'completed',?,?)"
  );
  for (const row of rows) insert.run(randomUUID(), row.userId, row.at, row.at + 1000, row.tokens, 0);
  db.close();
}

/** Fourteen past workdays of eight busy hours each, `tokens` per hour. */
function normalHistory(userId, timestamp, tokens) {
  const rows = [];
  for (let day = 1; day <= 14; day += 1) {
    for (let hour = 0; hour < 8; hour += 1) rows.push({ userId, at: timestamp - day * DAY + hour * HOUR, tokens });
  }
  return rows;
}

test('volumeThreshold uses the floor for new employees', () => {
  assert.equal(volumeThreshold([], VOLUME_FLOOR_TOKENS), VOLUME_FLOOR_TOKENS);
  assert.equal(volumeThreshold([], 1234), 1234);
});

test("volumeThreshold scales with the person's own p95", () => {
  const hours = Array.from({ length: 100 }, (_, index) => (index + 1) * 1000);
  // Nearest-rank p95 of 1000..100000 is 95000.
  assert.equal(volumeThreshold(hours, 1), VOLUME_MULTIPLIER * 95_000);
  assert.equal(volumeThreshold(hours.toReversed(), 1), VOLUME_MULTIPLIER * 95_000);
  assert.equal(volumeThreshold([10], 1_000_000), 1_000_000);
  assert.equal(HOURS_DENIALS_LIMIT, 3);
});

async function nightSetup(t) {
  const clock = { now: NIGHT };
  const app = await startControl(t, { now: () => clock.now });
  clock.now = WORKDAY;
  const admin = (await app.login()).token;
  const employee = await app.invite(admin);
  const policy = await app.request(`/admin/employees/${employee.id}/policy`, {
    method: 'POST',
    token: admin,
    body: { accessStart: '08:00', accessEnd: '18:00' },
  });
  assert.equal(policy.status, 200);
  return { app, admin, employee, clock };
}

const chatOnce = (app, token) =>
  app.request('/v1/chat/completions', {
    method: 'POST',
    token,
    body: { messages: [{ role: 'user', content: 'oi' }] },
  });

test('outside-hours login attempts block on the third episode in a day', async (t) => {
  const { app, admin, employee, clock } = await nightSetup(t);
  // The owner has no access hours, so the admin list stays readable at night.
  clock.now = NIGHT;
  for (let attempt = 1; attempt < HOURS_DENIALS_LIMIT; attempt += 1) {
    const denied = await app.login(employee.code, 'night');
    assert.equal(denied.response.status, 403);
    assert.equal(denied.error.code, 'outside_access_hours');
    const row = await employeeRow(app, admin, employee.id);
    assert.equal(row.blocked, false);
    assert.equal(row.blockedReason, null);
    clock.now += DENIAL_EPISODE_MS + 60_000;
  }
  await app.login(employee.code, 'night');
  const row = await employeeRow(app, admin, employee.id);
  assert.equal(row.blocked, true);
  assert.equal(row.blockedReason, 'auto_hours');
  const blocked = await app.login(employee.code, 'day');
  assert.equal(blocked.error.code, 'employee_blocked');
  // Denials from before the owner lifts the block do not count again the same night.
  clock.now += 60_000;
  await app.request(`/admin/employees/${employee.id}/block`, {
    method: 'POST',
    token: admin,
    body: { blocked: false },
  });
  clock.now += 60_000;
  assert.equal((await app.login(employee.code, 'night')).error.code, 'outside_access_hours');
  assert.equal((await employeeRow(app, admin, employee.id)).blocked, false);
});

test('outside-hours model requests count, session polling outside hours never counts', async (t) => {
  const { app, admin, employee, clock } = await nightSetup(t);
  const token = (await app.login(employee.code, 'day')).token;
  clock.now = NIGHT;
  for (let poll = 0; poll < 10; poll += 1) {
    const response = await app.request('/auth/session', { token });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: { code: 'outside_access_hours' } });
    clock.now += DENIAL_EPISODE_MS + 60_000;
  }
  assert.equal((await employeeRow(app, admin, employee.id)).blocked, false);
  for (let attempt = 0; attempt < HOURS_DENIALS_LIMIT; attempt += 1) {
    assert.equal((await chatOnce(app, token)).status, 403);
    clock.now += DENIAL_EPISODE_MS + 60_000;
  }
  const row = await employeeRow(app, admin, employee.id);
  assert.equal(row.blocked, true);
  assert.equal(row.blockedReason, 'auto_hours');
});

test('concurrent requests denied at closing time count as one episode', async (t) => {
  const { app, admin, employee, clock } = await nightSetup(t);
  const token = (await app.login(employee.code, 'day')).token;
  // 18:00 in São Paulo: the window just closed while four conversations were running.
  clock.now = Date.parse('2026-10-29T21:00:00Z');
  const burst = await Promise.all(Array.from({ length: 4 }, () => chatOnce(app, token)));
  assert.deepEqual(
    burst.map((response) => response.status),
    [403, 403, 403, 403]
  );
  clock.now += 30_000;
  for (let retry = 0; retry < 4; retry += 1) assert.equal((await chatOnce(app, token)).status, 403);
  assert.equal((await employeeRow(app, admin, employee.id)).blocked, false);
});

test('a volume spike blocks and unblocking clears the reason', async (t) => {
  const usual = 50_000;
  const threshold = volumeThreshold(Array(112).fill(usual), VOLUME_FLOOR_TOKENS);
  let spike = 100;
  const app = await startControl(t, {
    now: () => WORKDAY,
    upstreamFetch: async () => Response.json({ choices: [], usage: { prompt_tokens: spike, completion_tokens: 0 } }),
  });
  const admin = (await app.login()).token;
  const employee = await app.invite(admin);
  const token = (await app.login(employee.code, 'day')).token;
  seedRequests(join(app.directory, 'control.sqlite'), normalHistory(employee.id, WORKDAY, usual));
  const chat = () =>
    app.request('/v1/chat/completions', {
      method: 'POST',
      token,
      body: { messages: [{ role: 'user', content: 'oi' }] },
    });
  assert.equal((await chat()).status, 200);
  assert.equal((await employeeRow(app, admin, employee.id)).blocked, false);
  spike = threshold + 1;
  assert.equal((await chat()).status, 200);
  const row = await employeeRow(app, admin, employee.id);
  assert.equal(row.blocked, true);
  assert.equal(row.blockedReason, 'auto_volume');
  assert.equal((await chat()).status, 403);
  // A manual block over an automatic one makes it the owner's decision: no automatic reason.
  await app.request(`/admin/employees/${employee.id}/block`, { method: 'POST', token: admin, body: { blocked: true } });
  assert.equal((await employeeRow(app, admin, employee.id)).blockedReason, null);
  const unblock = await app.request(`/admin/employees/${employee.id}/block`, {
    method: 'POST',
    token: admin,
    body: { blocked: false },
  });
  assert.equal(unblock.status, 200);
  const cleared = await employeeRow(app, admin, employee.id);
  assert.equal(cleared.blocked, false);
  assert.equal(cleared.blockedReason, null);
  // The spike that caused the block does not block again right after the owner lifts it.
  spike = 100;
  assert.equal((await chat()).status, 200);
  assert.equal((await employeeRow(app, admin, employee.id)).blocked, false);
  const manual = await app.request(`/admin/employees/${employee.id}/block`, {
    method: 'POST',
    token: admin,
    body: { blocked: true },
  });
  assert.equal(manual.status, 200);
  const manualRow = await employeeRow(app, admin, employee.id);
  assert.equal(manualRow.blocked, true);
  assert.equal(manualRow.blockedReason, null);
});

test('a new employee is judged against the floor only', async (t) => {
  let spike = VOLUME_FLOOR_TOKENS - 1;
  const app = await startControl(t, {
    now: () => WORKDAY,
    upstreamFetch: async () => Response.json({ choices: [], usage: { prompt_tokens: spike, completion_tokens: 0 } }),
  });
  const admin = (await app.login()).token;
  const employee = await app.invite(admin);
  const token = (await app.login(employee.code, 'day')).token;
  const chat = () =>
    app.request('/v1/chat/completions', {
      method: 'POST',
      token,
      body: { messages: [{ role: 'user', content: 'oi' }] },
    });
  assert.equal((await chat()).status, 200);
  assert.equal((await employeeRow(app, admin, employee.id)).blocked, false);
  spike = 2;
  assert.equal((await chat()).status, 200);
  assert.equal((await employeeRow(app, admin, employee.id)).blockedReason, 'auto_volume');
});

test('owner is never auto-blocked', async (t) => {
  const app = await startControl(t, {
    now: () => WORKDAY,
    upstreamFetch: async () =>
      Response.json({ choices: [], usage: { prompt_tokens: VOLUME_FLOOR_TOKENS * 100, completion_tokens: 0 } }),
  });
  const admin = (await app.login()).token;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      token: admin,
      body: { messages: [{ role: 'user', content: 'oi' }] },
    });
    assert.equal(response.status, 200);
  }
  const store = createStore({ databasePath: ':memory:', adminCode: ADMIN_CODE, model: 'm', now: () => WORKDAY });
  t.after(() => store.close());
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(store.recordDenial('owner', 'request'), null);
  assert.equal(store.checkAutoBlock('owner'), null);
});

test('prune drops rows older than 183 days', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jr-prune-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'control.sqlite');
  const store = createStore({ databasePath, adminCode: ADMIN_CODE, model: 'm', now: () => WORKDAY });
  t.after(() => store.close());
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  const old = WORKDAY - 183 * DAY - 1;
  const kept = WORKDAY - 183 * DAY + 1;
  seedRequests(databasePath, [
    { userId: 'owner', at: old, tokens: 1 },
    { userId: 'owner', at: kept, tokens: 1 },
  ]);
  db.prepare("INSERT INTO denials (user_id,at,kind) VALUES ('owner',?,'login'),('owner',?,'request')").run(old, kept);
  store.prune();
  assert.deepEqual(
    db
      .prepare('SELECT started_at FROM requests')
      .all()
      .map((row) => row.started_at),
    [kept]
  );
  assert.deepEqual(
    db
      .prepare('SELECT at FROM denials')
      .all()
      .map((row) => row.at),
    [kept]
  );
});

test('prune also runs when the store opens', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jr-prune-open-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'control.sqlite');
  createStore({ databasePath, adminCode: ADMIN_CODE, model: 'm', now: () => WORKDAY }).close();
  seedRequests(databasePath, [{ userId: 'owner', at: WORKDAY - 200 * DAY, tokens: 1 }]);
  createStore({ databasePath, adminCode: ADMIN_CODE, model: 'm', now: () => WORKDAY }).close();
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
});

test('upstream receives X-JR-Employee, fallbacks never do', async (t) => {
  const seen = [];
  let primaryDown = false;
  const app = await startControl(t, {
    log: () => {},
    openRouterKey: 'openrouter-test-key-not-real',
    openRouterModels: 'deepseek/deepseek-chat:free',
    geminiKey: 'gemini-test-key-not-real-xx',
    upstreamFetch: async (url, init) => {
      seen.push({ url, headers: init.headers });
      if (primaryDown && url.includes('/mmx/')) return new Response('unavailable', { status: 401 });
      if (primaryDown && url.includes('openrouter')) return new Response('busy', { status: 429 });
      return Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
  const admin = (await app.login()).token;
  const employee = await app.invite(admin);
  const token = (await app.login(employee.code, 'day')).token;
  const chat = () =>
    app.request('/v1/chat/completions', {
      method: 'POST',
      token,
      body: { messages: [{ role: 'user', content: 'oi' }] },
    });
  assert.equal((await chat()).status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers['X-JR-Employee'], employee.id);
  seen.length = 0;
  primaryDown = true;
  assert.equal((await chat()).status, 200);
  const fallbacks = seen.filter((call) => !call.url.includes('/mmx/'));
  assert.ok(fallbacks.some((call) => call.url.includes('openrouter')));
  assert.ok(fallbacks.some((call) => call.url.includes('generativelanguage')));
  for (const call of fallbacks) assert.equal('X-JR-Employee' in call.headers, false);
  assert.equal(seen.find((call) => call.url.includes('/mmx/')).headers['X-JR-Employee'], employee.id);
});
