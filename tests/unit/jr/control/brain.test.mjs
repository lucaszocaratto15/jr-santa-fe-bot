import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { startControl } from './support.mjs';

const SECRET = 'brain-test-only-secret-0123456789';

async function fakeBrain(t, handler) {
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const entry = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(entry);
      const reply = handler?.(entry) ?? { status: 200, body: { ok: true } };
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, url: `http://127.0.0.1:${server.address().port}` };
}

async function setup(t, handler) {
  const brain = await fakeBrain(t, handler);
  const control = await startControl(t, { brainUrl: brain.url, brainSecret: SECRET });
  const owner = await control.login();
  return { brain, control, owner };
}

test('rejects an unauthenticated request without calling the brain', async (t) => {
  const { brain, control } = await setup(t);
  const response = await control.request('/api/brain/facts');
  assert.equal(response.status, 401);
  assert.equal(brain.seen.length, 0);
});

test('forwards method, path, query, body and the identity headers from the session', async (t) => {
  const { brain, control, owner } = await setup(t, () => ({ status: 201, body: { id: 7 } }));
  const response = await control.request('/api/brain/facts/search?q=cal&limit=3', {
    method: 'POST',
    token: owner.token,
    body: { text: 'olá' },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: 7 });
  const [call] = brain.seen;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/facts/search?q=cal&limit=3');
  assert.deepEqual(JSON.parse(call.body), { text: 'olá' });
  assert.equal(call.headers['x-brain-secret'], SECRET);
  assert.equal(call.headers['x-jr-user-id'], owner.user.id);
  assert.equal(call.headers['x-jr-role'], owner.user.role);
});

test('forwards a body-less GET even when the client sends a JSON content type', async (t) => {
  const { brain, control, owner } = await setup(t, () => ({ status: 200, body: { areas: [] } }));
  const response = await fetch(`${control.baseUrl}/api/brain/me`, {
    headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
  });
  assert.equal(response.status, 200);
  assert.equal(brain.seen[0].method, 'GET');
  assert.equal(brain.seen[0].url, '/me');
});

test('overwrites spoofed identity headers and forwards no other client header', async (t) => {
  const { brain, control, owner } = await setup(t);
  const employeeInvite = await control.invite(owner.token);
  const employee = await control.login(employeeInvite.code, 'func');
  assert.equal(employee.response.status, 200);
  await fetch(`${control.baseUrl}/api/brain/me`, {
    headers: {
      Authorization: `Bearer ${employee.token}`,
      'x-jr-user-id': 'owner',
      'x-jr-role': 'admin',
      'x-jr-title': 'Diretor',
      'x-brain-secret': 'attacker',
      'x-forwarded-for': '1.2.3.4',
      Cookie: 'a=b',
    },
  });
  const [call] = brain.seen;
  assert.equal(call.headers['x-jr-user-id'], employee.user.id);
  assert.notEqual(call.headers['x-jr-user-id'], 'owner');
  assert.notEqual(call.headers['x-jr-role'], 'admin');
  assert.equal(call.headers['x-jr-title'], undefined);
  assert.equal(call.headers['x-brain-secret'], SECRET);
  assert.equal(call.headers['x-forwarded-for'], undefined);
  assert.equal(call.headers.cookie, undefined);
  assert.equal(call.headers.authorization, undefined);
});

test('forwards the brain status and body as-is', async (t) => {
  const { control, owner } = await setup(t, () => ({ status: 403, body: { error: { code: 'forbidden' } } }));
  const response = await control.request('/api/brain/facts/1', { token: owner.token });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: { code: 'forbidden' } });
});

test('rejects bodies over 256 KB', async (t) => {
  const { brain, control, owner } = await setup(t);
  const response = await control.request('/api/brain/facts', {
    method: 'POST',
    token: owner.token,
    body: { text: 'x'.repeat(300 * 1024) },
  });
  assert.equal(response.status, 413);
  assert.equal(brain.seen.length, 0);
});

test('rejects path traversal and non-brain prefixes', async (t) => {
  const { brain, control, owner } = await setup(t);
  for (const path of ['/api/brain/../admin/employees', '/api/brain/%2e%2e/x', '/api/brain', '/api/brainx/facts']) {
    const response = await control.request(path, { token: owner.token });
    assert.equal(response.status, 404, path);
  }
  assert.equal(brain.seen.length, 0);
});

test('a brain that is down gives 503 brain_unavailable and /auth/session keeps working', async (t) => {
  const control = await startControl(t, { brainUrl: 'http://127.0.0.1:1', brainSecret: SECRET });
  const owner = await control.login();
  const response = await control.request('/api/brain/facts', { token: owner.token });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 'brain_unavailable' } });
  const session = await control.request('/auth/session', { token: owner.token });
  assert.equal(session.status, 200);
});

test('a brain that times out or is unreachable via brainFetch gives 503', async (t) => {
  const control = await startControl(t, {
    brainUrl: 'http://brain.invalid',
    brainSecret: SECRET,
    brainFetch: async () => {
      throw new Error('boom');
    },
  });
  const owner = await control.login();
  const response = await control.request('/api/brain/facts', { token: owner.token });
  assert.equal(response.status, 503);
});

test('refuses the reserved curator identity with 403', async () => {
  const calls = [];
  const { brainRequest } = await import('../../../../services/control/brain.mjs');
  const config = { brain: { url: 'http://brain.invalid', secret: SECRET } };
  await assert.rejects(
    brainRequest(config, { id: 'curator', role: 'employee' }, 'GET', '/x', undefined, async () => calls.push(1)),
    { status: 403 }
  );
  assert.equal(calls.length, 0);
});

test('brainRequest sends the identity and returns status and body', async (t) => {
  const brain = await fakeBrain(t, () => ({ status: 200, body: { peers: [] } }));
  const { brainRequest } = await import('../../../../services/control/brain.mjs');
  const result = await brainRequest(
    { brain: { url: brain.url, secret: SECRET } },
    { id: 'u1', role: 'employee', title: 'Engenheiro Ação' },
    'GET',
    '/peers'
  );
  assert.deepEqual(result, { status: 200, body: { peers: [] } });
  assert.equal(brain.seen[0].headers['x-jr-title'], encodeURIComponent('Engenheiro Ação'));
});

test('without a brain configured the route is 404', async (t) => {
  const control = await startControl(t);
  const owner = await control.login();
  const response = await control.request('/api/brain/facts', { token: owner.token });
  assert.equal(response.status, 404);
});

test('half a brain configuration is invalid', async (t) => {
  await assert.rejects(startControl(t, { brainUrl: 'http://127.0.0.1:9' }), /invalid_configuration/u);
});
