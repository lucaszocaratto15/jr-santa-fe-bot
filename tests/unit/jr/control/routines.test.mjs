import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTINE_RATE_LIMIT, ROUTINE_TTL_MS } from '../../../../services/control/routines.mjs';
import { startControl } from './support.mjs';

const routineBody = {
  name: 'Análise de pedido',
  instructions: 'Quando chegar um pedido, resuma os itens e o total.',
  conversationId: 'conv-pedido-1',
  cronJobId: 'cron-pedido-1',
};

async function createRoutine(app, token, body = routineBody) {
  const response = await app.request('/routines', { method: 'POST', token, body });
  const json = await response.json();
  return { response, ...json };
}

test('creates a routine with a one-time webhook secret and lists it for the owner only', async (t) => {
  const app = await startControl(t, { publicBaseUrl: 'https://jrsantafe.stratacerta.com.br/bot' });
  const admin = await app.login();
  const invite = await app.invite(admin.token, 'Funcionário rotina');
  const employee = await app.login(invite.code, 'employee-a');
  const otherInvite = await app.invite(admin.token, 'Outro funcionário');
  const other = await app.login(otherInvite.code, 'employee-b');

  const created = await createRoutine(app, employee.token);
  assert.equal(created.response.status, 201);
  assert.match(
    created.webhookUrl,
    /^https:\/\/jrsantafe\.stratacerta\.com\.br\/bot\/routines\/[0-9a-f-]{36}\/webhook\//
  );
  assert.equal(created.webhookSecret.length, 43);
  assert.equal(created.enabled, true);

  const mine = await app.request('/routines', { token: employee.token });
  assert.equal(mine.status, 200);
  assert.equal((await mine.json()).routines.length, 1);

  const theirs = await app.request('/routines', { token: other.token });
  assert.equal((await theirs.json()).routines.length, 0);
});

test('webhook with wrong secret returns 404 and does not enqueue', async (t) => {
  const app = await startControl(t);
  const admin = await app.login();
  const invite = await app.invite(admin.token);
  const employee = await app.login(invite.code, 'employee-secret');
  const created = await createRoutine(app, employee.token);

  const bad = await app.request(`/routines/${created.id}/webhook/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, {
    method: 'POST',
    body: { pedidoId: '1' },
  });
  assert.equal(bad.status, 404);

  const pending = await app.request('/routines/disparos', { token: employee.token });
  assert.equal((await pending.json()).triggers.length, 0);
});

test('valid webhook enqueues for heartbeat delivery and ack clears it', async (t) => {
  const app = await startControl(t);
  const admin = await app.login();
  const invite = await app.invite(admin.token);
  const employee = await app.login(invite.code, 'employee-deliver');
  const created = await createRoutine(app, employee.token);

  const posted = await app.request(`/routines/${created.id}/webhook/${created.webhookSecret}`, {
    method: 'POST',
    body: { pedidoId: '42', total: 120.5 },
  });
  assert.equal(posted.status, 202);
  const accepted = await posted.json();
  assert.equal(accepted.accepted, true);

  const pending = await app.request('/routines/disparos', { token: employee.token });
  const triggers = (await pending.json()).triggers;
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].cronJobId, 'cron-pedido-1');
  assert.deepEqual(triggers[0].payload, { pedidoId: '42', total: 120.5 });

  const ack = await app.request(`/routines/${created.id}/disparos/${triggers[0].id}/ack`, {
    method: 'POST',
    token: employee.token,
    body: { outcome: 'delivered' },
  });
  assert.equal(ack.status, 200);
  assert.equal((await ack.json()).status, 'delivered');

  const after = await app.request('/routines/disparos', { token: employee.token });
  assert.equal((await after.json()).triggers.length, 0);

  const history = await app.request(`/routines/${created.id}/history`, { token: employee.token });
  assert.equal((await history.json()).history[0].status, 'delivered');
});

test('disabled routine and revoked employee reject new webhooks', async (t) => {
  const app = await startControl(t);
  const admin = await app.login();
  const invite = await app.invite(admin.token);
  const employee = await app.login(invite.code, 'employee-disable');
  const created = await createRoutine(app, employee.token);

  await app.request(`/routines/${created.id}/disable`, { method: 'POST', token: employee.token, body: {} });
  const disabled = await app.request(`/routines/${created.id}/webhook/${created.webhookSecret}`, {
    method: 'POST',
    body: { pedidoId: '9' },
  });
  assert.equal(disabled.status, 404);

  await app.request(`/routines/${created.id}/enable`, { method: 'POST', token: employee.token, body: {} });
  await app.request(`/admin/employees/${employee.user.id}/revoke`, { method: 'POST', token: admin.token });
  const revoked = await app.request(`/routines/${created.id}/webhook/${created.webhookSecret}`, {
    method: 'POST',
    body: { pedidoId: '10' },
  });
  assert.equal(revoked.status, 404);
});

test('rate limit and payload size protect the webhook ingress', async (t) => {
  let clock = Date.now();
  const app = await startControl(t, { now: () => clock });
  const admin = await app.login();
  const invite = await app.invite(admin.token);
  const employee = await app.login(invite.code, 'employee-limit');
  const created = await createRoutine(app, employee.token);

  for (let i = 0; i < ROUTINE_RATE_LIMIT; i += 1) {
    const response = await app.request(`/routines/${created.id}/webhook/${created.webhookSecret}`, {
      method: 'POST',
      body: { n: i },
    });
    assert.equal(response.status, 202);
  }
  const limited = await app.request(`/routines/${created.id}/webhook/${created.webhookSecret}`, {
    method: 'POST',
    body: { n: 'overflow' },
  });
  assert.equal(limited.status, 429);

  clock += ROUTINE_TTL_MS + 1;
  const expiredPending = await app.request('/routines/disparos', { token: employee.token });
  assert.equal((await expiredPending.json()).triggers.length, 0);

  const huge = await app.request(`/routines/${created.id}/webhook/${created.webhookSecret}`, {
    method: 'POST',
    body: { blob: 'x'.repeat(70_000) },
  });
  assert.equal(huge.status, 413);
});
