import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { HANDBOOK_REQUEST_LIMIT, roleKey } from '../../../../services/control/handbook.mjs';
import { startControl } from './support.mjs';

const JPEG = (size = 64) => {
  const data = Buffer.alloc(size, 7);
  data[0] = 0xff;
  data[1] = 0xd8;
  data[2] = 0xff;
  return data.toString('base64');
};

const activity = (title = 'Lançar nota fiscal') => ({
  title,
  description: 'Lançar a NF no portal',
  frequency: 'daily',
  steps: [{ text: 'Abrir o portal' }, { text: 'Clicar em Emitir' }],
  confirmBefore: ['Valor da nota'],
});

async function setup(t, clock, extra = {}) {
  const app = await startControl(t, { ...(clock ? { now: () => clock.value } : {}), ...extra });
  const owner = await app.login();
  const hire = async (name, title, suffix) => {
    const created = await app.request('/admin/invites', {
      method: 'POST',
      token: owner.token,
      body: { name, ...(title === undefined ? {} : { title }) },
    });
    const invite = await created.json();
    const session = await app.login(invite.code, suffix);
    return { id: invite.id, token: session.token, user: session.user };
  };
  const a = await hire('Ana', 'Auxiliar de escritório', 'a');
  const b = await hire('Bruno', 'Auxiliar de escritório', 'b');
  const fin = await hire('Carla', 'Financeiro', 'c');
  const publish = (who, input) =>
    app.request('/handbook/items', {
      method: 'POST',
      token: who.token,
      body: { id: randomUUID(), kind: 'activity', source: 'taught', body: activity(), media: [], ...input },
    });
  const mine = async (who) => (await app.request('/handbook/mine', { token: who.token })).json();
  return { app, owner, hire, a, b, fin, publish, mine };
}

test('session user carries title', async (t) => {
  const { app, a } = await setup(t);
  const session = await (await app.request('/auth/session', { token: a.token })).json();
  assert.equal(session.user.title, 'Auxiliar de escritório');
  assert.equal(a.user.title, 'Auxiliar de escritório');
});

test('admin edits a title through /admin/employees/:id/title', async (t) => {
  const { app, owner, a } = await setup(t);
  const response = await app.request(`/admin/employees/${a.id}/title`, {
    method: 'POST',
    token: owner.token,
    body: { title: '  Financeiro ' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { title: 'Financeiro' });
  const session = await (await app.request('/auth/session', { token: a.token })).json();
  assert.equal(session.user.title, 'Financeiro');
  const denied = await app.request(`/admin/employees/${a.id}/title`, {
    method: 'POST',
    token: a.token,
    body: { title: 'Diretor' },
  });
  assert.equal(denied.status, 403);
  const tooLong = await app.request(`/admin/employees/${a.id}/title`, {
    method: 'POST',
    token: owner.token,
    body: { title: 'x'.repeat(81) },
  });
  assert.equal(tooLong.status, 400);
});

test('employee publishes and reads back their role handbook without author ids', async (t) => {
  const { a, b, publish, mine } = await setup(t);
  const mediaId = randomUUID();
  const response = await publish(a, { media: [{ id: mediaId, base64: JPEG() }] });
  assert.equal(response.status, 200);
  const { id } = await response.json();
  const payload = await mine(b);
  assert.deepEqual(payload.role, { key: 'auxiliar de escritorio', title: 'Auxiliar de escritório' });
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].id, id);
  assert.deepEqual(payload.items[0].media, [mediaId]);
  assert.deepEqual(payload.items[0].body, activity());
  const text = JSON.stringify(payload);
  assert.equal(text.includes(a.id), false);
  assert.equal(text.includes('Ana'), false);
  assert.equal(text.includes('author'), false);
});

test('publish without a title returns 409 no_role', async (t) => {
  const { hire, publish, mine } = await setup(t);
  const nobody = await hire('Davi', undefined, 'd');
  const response = await publish(nobody);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'no_role');
  assert.deepEqual(await mine(nobody), { role: null, items: [], indicators: null });
});

test('another employee cannot overwrite an item id', async (t) => {
  const { a, b, publish, mine } = await setup(t);
  const id = randomUUID();
  await publish(a, { id });
  const attempt = await publish(b, { id, body: activity('Sequestrado') });
  assert.equal(attempt.status, 403);
  const payload = await mine(a);
  assert.equal(payload.items[0].body.title, 'Lançar nota fiscal');
  const deleteAttempt = await publish(b, { id: randomUUID(), media: [] });
  assert.equal(deleteAttempt.status, 200);
});

test('a media id of another item cannot be taken over', async (t) => {
  const { a, b, publish } = await setup(t);
  const mediaId = randomUUID();
  await publish(a, { media: [{ id: mediaId, base64: JPEG() }] });
  const attempt = await publish(b, { media: [{ id: mediaId, base64: JPEG(32) }] });
  assert.equal(attempt.status, 403);
});

test('media of another role is 403 for employees and 200 for admin', async (t) => {
  const { app, owner, a, fin, publish } = await setup(t);
  const mediaId = randomUUID();
  await publish(fin, { media: [{ id: mediaId, base64: JPEG() }] });
  const denied = await app.request(`/handbook/media/${mediaId}`, { token: a.token });
  assert.equal(denied.status, 403);
  const own = await app.request(`/handbook/media/${mediaId}`, { token: fin.token });
  assert.equal(own.status, 200);
  const admin = await app.request(`/handbook/media/${mediaId}`, { token: owner.token });
  assert.equal(admin.status, 200);
  assert.deepEqual(await admin.json(), { mime: 'image/jpeg', base64: JPEG() });
});

test('an employee only ever reads their own role', async (t) => {
  const { app, a, fin, publish, mine } = await setup(t);
  await publish(fin, { body: activity('Conciliar banco') });
  const payload = await mine(a);
  assert.equal(payload.items.length, 0);
  const query = await app.request('/handbook/mine?role=financeiro', { token: a.token });
  assert.equal((await query.json()).items.length, 0);
  const admin = await app.request('/admin/handbook/roles/financeiro', { token: a.token });
  assert.equal(admin.status, 403);
});

test('roleKey ignores accents, case and spacing', () => {
  assert.equal(roleKey('Auxiliar  de Escritório'), 'auxiliar de escritorio');
  assert.equal(roleKey(' AUXILIAR DE ESCRITORIO '), 'auxiliar de escritorio');
});

const indicators = (times, minutes) => ({
  kind: 'indicators',
  source: 'learn',
  body: {
    weekStart: '2026-10-19',
    activities: [{ title: 'Lançar NF', timesPerWeek: times, minutesPerRun: minutes }],
    timePerApp: [{ app: 'Excel', minutesPerDay: times * 10 }],
  },
});

test('indicators are averaged per role and never per person', async (t) => {
  const { app, owner, a, b, publish, mine } = await setup(t);
  await publish(a, indicators(1, 1));
  await publish(a, indicators(4, 6));
  await publish(b, indicators(6, 8));
  const payload = await mine(a);
  assert.equal('indicators' in payload, false);
  assert.equal(payload.indicatorsHidden, true);
  assert.equal(
    payload.items.some((item) => item.kind === 'indicators'),
    false
  );
  const admin = await (
    await app.request(`/admin/handbook/roles/${encodeURIComponent('auxiliar de escritorio')}`, { token: owner.token })
  ).json();
  assert.deepEqual(admin.indicators, {
    activities: [{ title: 'Lançar NF', timesPerWeek: 5, minutesPerRun: 7 }],
    timePerApp: [{ app: 'Excel', minutesPerDay: 50 }],
    contributors: 2,
  });
  for (const text of [JSON.stringify(payload), JSON.stringify(admin)]) {
    assert.equal(text.includes(a.id) || text.includes(b.id), false);
    assert.equal(text.includes('Ana') || text.includes('Bruno'), false);
    assert.equal(text.includes('"timesPerWeek":4') || text.includes('"timesPerWeek":6'), false);
  }
});

test('indicators older than 28 days are left out', async (t) => {
  const clock = { value: Date.UTC(2026, 9, 1) };
  const env = await setup(t, clock);
  const { a, publish } = env;
  await publish(a, {
    kind: 'indicators',
    source: 'learn',
    body: { weekStart: '2026-09-28', activities: [], timePerApp: [{ app: 'Excel', minutesPerDay: 10 }] },
  });
  clock.value += 29 * 86_400_000;
  const { app, owner } = env;
  const role = await app.request(`/admin/handbook/roles/${encodeURIComponent('auxiliar de escritorio')}`, {
    token: owner.token,
  });
  assert.equal((await role.json()).indicators, null);
});

test('withdraw-learn removes only source=learn items of the caller', async (t) => {
  const { app, a, b, publish, mine } = await setup(t);
  await publish(a, { source: 'taught', body: activity('Ensinada') });
  await publish(a, { source: 'learn', body: activity('Observada A') });
  await publish(b, { source: 'learn', body: activity('Observada B') });
  const response = await app.request('/handbook/withdraw-learn', { method: 'POST', token: a.token });
  assert.equal(response.status, 200);
  const titles = (await mine(b)).items.map((item) => item.body.title).toSorted();
  assert.deepEqual(titles, ['Ensinada', 'Observada B']);
});

test('items keep their role after the author title changes', async (t) => {
  const { app, owner, a, b, publish, mine } = await setup(t);
  await publish(a);
  await app.request(`/admin/employees/${a.id}/title`, {
    method: 'POST',
    token: owner.token,
    body: { title: 'Gerente' },
  });
  assert.equal((await mine(b)).items.length, 1);
  const renamed = await mine(a);
  assert.deepEqual(renamed.role, { key: 'gerente', title: 'Gerente' });
  assert.deepEqual(renamed.items, []);
  assert.equal('indicators' in renamed, false);
});

test('revoked employee items stay in the role handbook', async (t) => {
  const { app, owner, a, b, publish, mine } = await setup(t);
  await publish(a);
  await app.request(`/admin/employees/${a.id}/revoke`, { method: 'POST', token: owner.token });
  assert.equal((await mine(b)).items.length, 1);
});

test('oversized media (>300 KB) is rejected with 413', async (t) => {
  const { a, publish, mine } = await setup(t);
  const response = await publish(a, { media: [{ id: randomUUID(), base64: JPEG(300 * 1024 + 1) }] });
  assert.equal(response.status, 413);
  const tooMany = await publish(a, {
    media: Array.from({ length: 41 }, () => ({ id: randomUUID(), base64: JPEG() })),
  });
  assert.equal(tooMany.status, 413);
  const bigBody = await publish(a, { body: { ...activity(), description: 'x'.repeat(65 * 1024) } });
  assert.equal(bigBody.status, 413);
  const notJpeg = await publish(a, { media: [{ id: randomUUID(), base64: Buffer.from('png?').toString('base64') }] });
  assert.equal(notJpeg.status, 400);
  assert.equal((await mine(a)).items.length, 0);
});

test('/admin/handbook/roles requires admin', async (t) => {
  const { app, owner, a, fin, publish } = await setup(t);
  await publish(a);
  await publish(fin, { body: activity('Conciliar banco') });
  assert.equal((await app.request('/admin/handbook/roles', { token: a.token })).status, 403);
  const response = await app.request('/admin/handbook/roles', { token: owner.token });
  assert.equal(response.status, 200);
  const { roles } = await response.json();
  assert.deepEqual(
    roles.map((role) => [role.key, role.title, role.activities]),
    [
      ['auxiliar de escritorio', 'Auxiliar de escritório', 1],
      ['financeiro', 'Financeiro', 1],
    ]
  );
  assert.equal(JSON.stringify(roles).includes(a.id), false);
});

test('admin is read-only: it cannot delete an item and has no approval route', async (t) => {
  const { app, owner, a, publish, mine } = await setup(t);
  const { id } = await (await publish(a)).json();
  const removed = await app.request(`/handbook/items/${id}`, { method: 'DELETE', token: owner.token });
  assert.equal(removed.status, 403);
  for (const path of ['/admin/handbook/approve', `/admin/handbook/items/${id}`, '/admin/handbook/pending']) {
    assert.equal((await app.request(path, { method: 'POST', token: owner.token, body: {} })).status, 404);
  }
  assert.equal((await mine(a)).items.length, 1);
});

test('the author withdraws an item and its media is gone', async (t) => {
  const { app, a, b, publish, mine } = await setup(t);
  const mediaId = randomUUID();
  const { id } = await (await publish(a, { media: [{ id: mediaId, base64: JPEG() }] })).json();
  assert.equal((await app.request(`/handbook/items/${id}`, { method: 'DELETE', token: b.token })).status, 403);
  assert.equal((await app.request(`/handbook/items/${id}`, { method: 'DELETE', token: a.token })).status, 200);
  assert.equal((await mine(a)).items.length, 0);
  assert.equal((await app.request(`/handbook/media/${mediaId}`, { token: a.token })).status, 404);
});

test('indicators rows older than the 4-week window are deleted on the next write', async (t) => {
  const clock = { value: Date.UTC(2026, 9, 1) };
  const { app, a, b, publish } = await setup(t, clock);
  await publish(a, {
    kind: 'indicators',
    source: 'learn',
    body: { weekStart: '2026-09-28', activities: [], timePerApp: [{ app: 'Excel', minutesPerDay: 10 }] },
  });
  await publish(a, { source: 'learn', body: activity('Observada antiga') });
  const db = new DatabaseSync(join(app.directory, 'control.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const count = (kind) => db.prepare('SELECT COUNT(*) AS n FROM handbook_items WHERE kind = ?').get(kind).n;
  assert.equal(count('indicators'), 1);
  clock.value += 27 * 86_400_000;
  await publish(b, { body: activity('Ainda dentro da janela') });
  assert.equal(count('indicators'), 1);
  clock.value += 2 * 86_400_000;
  await publish(b, {
    kind: 'indicators',
    source: 'learn',
    body: { weekStart: '2026-10-26', activities: [], timePerApp: [{ app: 'Excel', minutesPerDay: 20 }] },
  });
  assert.equal(count('indicators'), 1);
  const authors = db.prepare("SELECT author_id FROM handbook_items WHERE kind = 'indicators'").all();
  assert.deepEqual(
    authors.map((row) => row.author_id),
    [b.id]
  );
  // Activities are not indicators: they stay until withdrawn.
  assert.equal(count('activity'), 2);
});

test('a publish request over the 6 MB cap is rejected with 413 and one under it is accepted', async (t) => {
  const { a, publish, mine } = await setup(t);
  const big = await publish(a, {
    media: Array.from({ length: 16 }, () => ({ id: randomUUID(), base64: JPEG(300 * 1024) })),
  });
  assert.equal(big.status, 413);
  assert.equal((await mine(a)).items.length, 0);
  const fits = await publish(a, {
    media: Array.from({ length: 13 }, () => ({ id: randomUUID(), base64: JPEG(300 * 1024) })),
  });
  assert.equal(fits.status, 200);
  assert.equal(HANDBOOK_REQUEST_LIMIT, 6 * 1024 * 1024);
});

// ---- role handbooks visible within an area (company brain /peers) ----

const BRAIN_SECRET = 'brain-test-only-secret-0123456789';

/** Fake brain: `peersOf[userId]` is that caller's `/peers` list; `down` answers 500; `hang` never answers. */
async function withBrain(t) {
  const state = { peersOf: {}, down: false, hang: false, calls: 0 };
  const server = createServer((request, response) => {
    state.calls += 1;
    if (state.hang) return;
    const id = request.headers['x-jr-user-id'];
    const reply = state.down || request.url !== '/peers' ? 500 : 200;
    response.writeHead(reply, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply === 200 ? { peers: state.peersOf[id] ?? [] } : { error: { code: 'x' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const brainUrl = `http://127.0.0.1:${server.address().port}`;
  const env = await setup(t, undefined, { brainUrl, brainSecret: BRAIN_SECRET });
  return { ...env, state };
}

const roleUrl = (key) => `/handbook/roles/${encodeURIComponent(key)}`;

async function areaSetup(t) {
  const env = await withBrain(t);
  const { hire, publish, state } = env;
  const frota1 = await hire('Fabio', 'Frota', 'f1');
  const frota2 = await hire('Fatima', 'Frota', 'f2');
  const fin = env.fin;
  await publish(frota2, { body: activity('Abastecer caminhão') });
  await publish(frota2, indicators(3, 5));
  await publish(fin, { body: activity('Conciliar banco') });
  const peers = (level) => [{ userId: frota2.id, areas: [{ areaId: 1, level }] }];
  state.peersOf[frota1.id] = peers('colaborador');
  return { ...env, frota1, frota2, peers };
}

test('colaborador reads activity items of area peers but not of other roles, and gets no indicators', async (t) => {
  const { app, frota1, fin } = await areaSetup(t);
  const list = await (await app.request('/handbook/roles', { token: frota1.token })).json();
  assert.deepEqual(
    list.roles.map((role) => role.key),
    ['frota']
  );
  const frota = await app.request(roleUrl('frota'), { token: frota1.token });
  assert.equal(frota.status, 200);
  const payload = await frota.json();
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].body.title, 'Abastecer caminhão');
  assert.equal('indicators' in payload, false);
  assert.equal(JSON.stringify(payload).includes('timesPerWeek'), false);
  const denied = await app.request(roleUrl('financeiro'), { token: frota1.token });
  assert.equal(denied.status, 403);
  assert.equal(fin.user.title, 'Financeiro');
});

test('a hung brain only delays handbook reads by the 2 s /peers timeout, then falls back to the own role', async (t) => {
  const { app, frota1, state } = await areaSetup(t);
  state.hang = true;
  const started = Date.now();
  const response = await app.request('/handbook/roles', { token: frota1.token });
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);
  assert.ok(elapsed >= 1500 && elapsed < 3500, `elapsed ${elapsed}`);
});

test('gestor of the shared area sees the indicators of the peers role', async (t) => {
  const { app, frota1, state, peers } = await areaSetup(t);
  state.peersOf[frota1.id] = peers('gestor');
  const payload = await (await app.request(roleUrl('frota'), { token: frota1.token })).json();
  assert.equal(payload.indicators.contributors, 1);
  assert.equal(payload.indicators.activities[0].timesPerWeek, 3);
  const financeiro = await app.request(roleUrl('financeiro'), { token: frota1.token });
  assert.equal(financeiro.status, 403);
});

test('owner sees every role with indicators', async (t) => {
  const { app, owner } = await areaSetup(t);
  const list = await (await app.request('/handbook/roles', { token: owner.token })).json();
  assert.deepEqual(list.roles.map((role) => role.key).sort(), ['financeiro', 'frota']);
  const payload = await (await app.request(roleUrl('frota'), { token: owner.token })).json();
  assert.equal(payload.indicators.contributors, 1);
});

test('peers media is readable by the area, other roles media is not', async (t) => {
  const { app, frota1, frota2, fin, publish } = await areaSetup(t);
  const peerMedia = randomUUID();
  const otherMedia = randomUUID();
  await publish(frota2, { media: [{ id: peerMedia, base64: JPEG() }] });
  await publish(fin, { media: [{ id: otherMedia, base64: JPEG() }] });
  assert.equal((await app.request(`/handbook/media/${peerMedia}`, { token: frota1.token })).status, 200);
  assert.equal((await app.request(`/handbook/media/${otherMedia}`, { token: frota1.token })).status, 403);
});

test('brain down falls back to the own role only, never an error', async (t) => {
  const { app, frota1, state, publish } = await areaSetup(t);
  await publish(frota1, { body: activity('Revisar pneus') });
  state.down = true;
  const list = await app.request('/handbook/roles', { token: frota1.token });
  assert.equal(list.status, 200);
  assert.deepEqual(
    (await list.json()).roles.map((role) => role.key),
    ['frota']
  );
  const own = await (await app.request(roleUrl('frota'), { token: frota1.token })).json();
  assert.equal(own.items.length, 2);
  const fin = await app.request(roleUrl('financeiro'), { token: frota1.token });
  assert.equal(fin.status, 403);
});

test('without a brain configured an employee reads only their own role', async (t) => {
  const { app, a, fin, publish } = await setup(t);
  await publish(fin, { body: activity('Conciliar banco') });
  await publish(a, { body: activity('Arquivar') });
  const list = await (await app.request('/handbook/roles', { token: a.token })).json();
  assert.deepEqual(
    list.roles.map((role) => role.key),
    ['auxiliar de escritorio']
  );
  assert.equal((await app.request(roleUrl('financeiro'), { token: a.token })).status, 403);
});

test('/handbook/mine: indicators only for the owner or a gestor of a shared area with the role', async (t) => {
  const { app, owner, frota1, state, peers, frota2 } = await areaSetup(t);
  state.peersOf[frota2.id] = [{ userId: frota1.id, areas: [{ areaId: 1, level: 'colaborador' }] }];
  const colab = await (await app.request('/handbook/mine', { token: frota2.token })).json();
  assert.equal('indicators' in colab, false);
  assert.equal(colab.indicatorsHidden, true);
  assert.equal(colab.items.length, 1);
  state.peersOf[frota2.id] = [{ userId: frota1.id, areas: [{ areaId: 1, level: 'gestor' }] }];
  const gestor = await (await app.request('/handbook/mine', { token: frota2.token })).json();
  assert.equal(gestor.indicators.contributors, 1);
  assert.equal(peers('gestor').length, 1);
  const ownerMine = await (await app.request('/handbook/mine', { token: owner.token })).json();
  assert.equal(ownerMine.indicatorsHidden, undefined);
});

test('a non-owner admin is an employee on the area routes', async (t) => {
  const { app, hire } = await areaSetup(t);
  const adm = await hire('Adm', 'Frota', 'adm');
  const db = new DatabaseSync(join(app.directory, 'control.sqlite'));
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adm.id);
  db.close();
  const list = await (await app.request('/handbook/roles', { token: adm.token })).json();
  assert.deepEqual(
    list.roles.map((role) => role.key),
    ['frota']
  );
  assert.equal((await app.request(roleUrl('financeiro'), { token: adm.token })).status, 403);
  // The pre-existing admin routes are unchanged.
  assert.equal((await app.request('/admin/handbook/roles/financeiro', { token: adm.token })).status, 200);
});
