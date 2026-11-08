import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { startBrain } from './support.mjs';

const member = (store, userId, areaId, level = 'colaborador', primary = true) =>
  store.members.set(userId, [...store.members.of(userId), { areaId, level, primary }]);

test('secret and identity are enforced; health needs neither', async (t) => {
  const { call, request } = await startBrain(t);
  assert.equal((await request('/health', { secret: null, user: null })).status, 200);
  assert.equal((await call('/me', { secret: null })).status, 401);
  assert.equal((await call('/me', { secret: 'wrong' })).body.error.code, 'unauthorized');
  assert.equal((await call('/me', { secret: 'x'.repeat(5000) })).status, 401);
  assert.equal((await call('/me', { user: null })).status, 400);
  assert.equal((await call('/nope')).status, 404);
});

test('rejects bodies over 256 KB and non-JSON bodies', async (t) => {
  const { request } = await startBrain(t);
  const big = JSON.stringify({ query: 'a'.repeat(300_000) });
  assert.equal((await request('/search', { method: 'POST', body: big })).status, 413);
  assert.equal((await request('/search', { method: 'POST', body: '{nope' })).status, 400);
});

test('search returns the public projection and respects the scope', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  fact(areas.frota, 'Caminhao pipa abastece na garagem norte', { erpRef: 'obra:123' });
  fact(areas.compras, 'Caminhao de entrega do fornecedor chega as terças');
  member(store, 'bia', areas.frota);
  const { status, body } = await call('/search', { user: 'bia', method: 'POST', body: { query: 'caminhao' } });
  assert.equal(status, 200);
  assert.equal(body.facts.length, 1);
  assert.deepEqual(Object.keys(body.facts[0]).toSorted(), [
    'area',
    'confidence',
    'date',
    'erpRef',
    'id',
    'noteType',
    'risk',
    'text',
    'version',
  ]);
  assert.equal(body.facts[0].area, 'Frota');
  assert.equal(body.facts[0].erpRef, 'obra:123');
});

test('search clamps limit and maxChars regardless of input', async (t) => {
  const { call, areas, fact } = await startBrain(t);
  for (let i = 0; i < 9; i += 1) fact(areas.general, `Regra de pintura numero ${i} ${'x'.repeat(400)}`);
  const { body } = await call('/search', {
    method: 'POST',
    body: { query: 'regra pintura', limit: 50, maxChars: 99999 },
  });
  assert.ok(body.facts.length <= 5);
  assert.ok(body.facts.reduce((sum, f) => sum + f.text.length, 0) <= 1500);
});

test('reads of high facts are logged without the query; low reads are not', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  const high = fact(areas.compras, 'Contrato do fornecedor Y vence em marco', { risk: 'high' });
  fact(areas.compras, 'Fornecedor Y entrega pela manha');
  member(store, 'gil', areas.compras, 'gestor');
  await call('/search', { user: 'gil', method: 'POST', body: { query: 'fornecedor Y secretissima' } });
  const log = store.log.list();
  assert.deepEqual(
    log.map((entry) => [entry.userId, entry.action, entry.factId]),
    [['gil', 'read_high', high]]
  );
  assert.ok(!JSON.stringify(log).includes('secretissima'));
});

test('colaborador cannot PATCH; gestor can suspend only their own area and cannot bypass consent', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  const compras = fact(areas.compras, 'Compras fecha pedidos na sexta');
  const frota = fact(areas.frota, 'Frota revisa caminhoes no mes');
  member(store, 'col', areas.compras);
  member(store, 'gil', areas.compras, 'gestor');
  const patch = (user, id, body) => call(`/manage/facts/${id}`, { method: 'PATCH', user, body });
  assert.equal((await patch('col', compras, { text: 'x y z' })).status, 404);
  assert.equal((await patch('gil', frota, { suspended: true })).status, 404);
  const edit = await patch('gil', compras, { text: 'Compras fecha pedidos na quinta' });
  assert.deepEqual([edit.status, edit.body.error.code], [409, 'consent_required']);
  assert.equal(store.facts.get(compras).text, 'Compras fecha pedidos na sexta');
  assert.equal((await patch('gil', compras, { suspended: true })).status, 200);
  assert.equal(store.facts.get(compras).suspended, true);
  assert.equal(store.facts.get(frota).suspended, false);
  assert.equal((await call('/manage/facts', { user: 'col' })).status, 403);
});

test('owner cannot expose high facts by reclassifying through the legacy PATCH route', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  const id = fact(areas.compras, 'Desconto maximo ao cliente e de cinco por cento', { risk: 'high' });
  member(store, 'col', areas.compras);
  const search = () => call('/search', { user: 'col', method: 'POST', body: { query: 'desconto cliente' } });
  assert.equal((await search()).body.facts.length, 0);
  const demotion = await call(`/manage/facts/${id}`, { method: 'PATCH', body: { risk: 'low' } });
  assert.deepEqual([demotion.status, demotion.body.error.code], [409, 'consent_required']);
  assert.equal(store.facts.get(id).risk, 'high');
  assert.equal((await search()).body.facts.length, 0);
});

test('member changes are reflected on the very next search', async (t) => {
  const { call, areas, fact } = await startBrain(t);
  fact(areas.frota, 'Oficina da frota fica na rua Sete');
  const search = () => call('/search', { user: 'bia', method: 'POST', body: { query: 'oficina frota' } });
  assert.equal((await search()).body.facts.length, 0);
  const put = (memberships) => call('/manage/members/bia', { method: 'PUT', body: { memberships } });
  assert.equal((await put([{ areaId: areas.frota, level: 'colaborador', primary: true }])).status, 200);
  assert.equal((await search()).body.facts.length, 1);
  await put([]);
  assert.equal((await search()).body.facts.length, 0);
});

test('legacy PATCH validates shape and refuses content, source-area and risk changes without reviewed consent', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  member(store, 'gil', areas.compras, 'gestor');
  member(store, 'gil', areas.frota, 'gestor', false);
  member(store, 'hal', areas.compras, 'gestor');
  const id = fact(areas.compras, 'Compras usa cotacao com tres fornecedores');
  const patch = (user, target, body) => call(`/manage/facts/${target}`, { method: 'PATCH', user, body });

  assert.equal((await patch('gil', id, { text: null })).status, 400);
  assert.equal((await patch('gil', id, { areaId: null })).status, 400);
  assert.equal((await patch('gil', id, { bogus: 1 })).status, 400);
  const secret = await patch('gil', id, { text: 'Contato fulano@empresa.com.br para cotacao' });
  assert.deepEqual([secret.status, secret.body.error.code], [409, 'consent_required']);
  assert.equal(store.facts.get(id).text, 'Compras usa cotacao com tres fornecedores');

  // Even a manager of both areas must use the reviewed proposal flow.
  for (const user of ['hal', 'gil']) {
    const moved = await patch(user, id, { areaId: areas.frota });
    assert.deepEqual([moved.status, moved.body.error.code], [409, 'consent_required']);
  }
  assert.equal(store.facts.get(id).areaId, areas.compras);

  // Neither high nor low facts may be promoted to a broader audience by a legacy patch.
  const high = fact(areas.compras, 'Salario do cargo de comprador', { risk: 'high' });
  const promoteHigh = await patch('hal', high, { general: true });
  assert.deepEqual([promoteHigh.status, promoteHigh.body.error.code], [409, 'consent_required']);
  const low = fact(areas.compras, 'Compras fica no segundo andar');
  assert.equal((await patch('hal', low, { general: true })).status, 409);
  assert.equal(store.facts.get(low).areaId, areas.compras);
  assert.equal((await patch('hal', low, { text: 'Compras fica no terceiro andar' })).status, 409);

  // a fact in a supersession chain cannot change area or risk
  const old = fact(areas.compras, 'Prazo de pagamento padrao e trinta dias');
  const next = store.facts.supersede(old, {
    areaId: areas.compras,
    risk: 'low',
    text: 'Prazo de pagamento padrao e quarenta dias',
    sourceKind: 'usuario_afirmou',
    authorUserId: 'ana',
    confidence: 9,
  });
  for (const target of [old, next]) {
    const moved = await patch('owner', target, { risk: 'high' });
    assert.deepEqual([moved.status, moved.body.error.code], [409, 'consent_required']);
  }
  assert.equal((await patch('owner', next, { text: 'Prazo de pagamento padrao e quarenta e cinco dias' })).status, 409);
  assert.equal(store.facts.get(next).text, 'Prazo de pagamento padrao e quarenta dias');
});

test('feedback: gestor/owner suspend immediately, colaborador does not', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  member(store, 'col', areas.compras);
  member(store, 'gil', areas.compras, 'gestor');
  const a = fact(areas.compras, 'Regra A de cotacao');
  const b = fact(areas.compras, 'Regra B de cotacao');
  const vote = (user, factId) => call('/feedback', { user, method: 'POST', body: { factId, reason: 'errado' } });
  assert.equal((await vote('col', a)).status, 200);
  assert.equal(store.facts.get(a).suspended, false);
  assert.equal((await vote('gil', b)).status, 200);
  assert.equal(store.facts.get(b).suspended, true);
  const search = await call('/search', { user: 'col', method: 'POST', body: { query: 'regra cotacao' } });
  assert.deepEqual(
    search.body.facts.map((f) => f.id),
    [a]
  );
});

test('feedback on a fact the user cannot read answers like a missing id', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  member(store, 'col', areas.frota);
  const hidden = fact(areas.compras, 'Fato de outra area');
  const high = fact(areas.frota, 'Fato de alto risco', { risk: 'high' });
  const vote = (factId) => call('/feedback', { user: 'col', method: 'POST', body: { factId } });
  const missing = await vote(99999);
  for (const id of [hidden, high]) assert.deepEqual(await vote(id), missing);
  assert.equal(missing.status, 404);
  assert.equal(store.facts.get(hidden).suspended, false);
});

test('JR management alone cannot suspend a fact without ERP review authorization', async (t) => {
  const { call, store, areas, fact } = await startBrain(t, {
    resolveAuthorization: async (identity) => ({
      jrUserId: identity.userId,
      erpUserId: `erp_${identity.userId}`,
      organizationId: 'jr',
      scope: { all: true },
      publishAreaIds: [],
      reviewAreaIds: [],
    }),
  });
  member(store, 'gil', areas.compras, 'gestor');
  const id = fact(areas.compras, 'Regra de cotacao revisada');
  const result = await call('/feedback', { user: 'gil', method: 'POST', body: { factId: id } });
  assert.deepEqual(result.body, { recorded: true, suspended: false });
  assert.equal(store.facts.get(id).suspended, false);
});

test('/me and /peers shapes', async (t) => {
  const { call, store, areas } = await startBrain(t);
  member(store, 'gil', areas.compras, 'gestor');
  member(store, 'col', areas.compras);
  member(store, 'col', areas.frota, 'colaborador', false);
  member(store, 'fro', areas.frota);
  const me = await call('/me', { user: 'col' });
  assert.deepEqual(me.body, {
    areas: [
      { id: areas.frota, name: 'Frota', level: 'colaborador', primary: false },
      { id: areas.compras, name: 'Compras', level: 'colaborador', primary: true },
    ],
    isDirector: false,
    manages: [],
  });
  assert.deepEqual((await call('/me', { user: 'gil' })).body.manages, [areas.compras]);
  assert.equal((await call('/me')).body.isDirector, true);
  const peers = await call('/peers', { user: 'col' });
  assert.deepEqual(
    peers.body.peers.toSorted((a, b) => a.userId.localeCompare(b.userId)),
    [
      { userId: 'fro', areas: [{ areaId: areas.frota, level: 'colaborador' }] },
      { userId: 'gil', areas: [{ areaId: areas.compras, level: 'colaborador' }] },
    ]
  );
});

test('/peers ignores Geral and the fallback area memberships', async (t) => {
  const { call, store, areas } = await startBrain(t);
  member(store, 'col', areas.general, 'colaborador', false);
  member(store, 'col', areas.frota);
  member(store, 'fro', areas.frota);
  member(store, 'out', areas.general, 'colaborador', false);
  member(store, 'out', areas.compras);
  member(store, 'only', areas.general);
  const peers = await call('/peers', { user: 'col' });
  assert.deepEqual(peers.body.peers, [{ userId: 'fro', areas: [{ areaId: areas.frota, level: 'colaborador' }] }]);
  assert.deepEqual((await call('/peers', { user: 'only' })).body.peers, []);
});

test('legacy capture requires explicit consent, never invokes the curator and persists no raw text', async (t) => {
  const seen = [];
  const curator = { enqueue: (identity, payload) => seen.push({ identity, payload }), drain: async () => {} };
  const { call, directory, store } = await startBrain(t, { curator });
  const marker = 'ZXQ-texto-bruto-unico-98765';
  const { status } = await call('/capture', {
    user: 'ana',
    method: 'POST',
    body: {
      conversationRef: 'c1',
      bot: 'jr',
      messages: [
        { role: 'user', text: marker },
        { role: 'assistant', text: 'ok' },
      ],
    },
  });
  assert.equal(status, 503);
  assert.equal(seen.length, 0);
  store.log.add({ userId: 'x', action: 'noop' });
  for (const file of await readdir(directory)) {
    assert.ok(!(await readFile(join(directory, file))).includes(marker), `${file} holds raw text`);
  }
  const bad = await call('/capture', {
    method: 'POST',
    body: { conversationRef: 'c', bot: 'b', messages: [{ role: 'x', text: 'y' }] },
  });
  assert.deepEqual([bad.status, bad.body.error.code], [503, 'consent_required']);
});

test('legacy capture is refused before a failing curator can run', async (t) => {
  let calls = 0;
  const curator = {
    enqueue: () => {
      calls += 1;
      throw new Error('boom');
    },
    drain: async () => {},
  };
  const { call } = await startBrain(t, { curator });
  const { status } = await call('/capture', { method: 'POST', body: { conversationRef: 'c', bot: 'b', messages: [] } });
  assert.equal(status, 503);
  assert.equal(calls, 0);
});

test('consent round-trip', async (t) => {
  const { call } = await startBrain(t, { now: () => 1_700_000_000_000 });
  assert.deepEqual((await call('/consent', { user: 'ana' })).body, { version: null, at: null });
  const saved = await call('/consent', { user: 'ana', method: 'POST', body: { termVersion: '1.4' } });
  assert.deepEqual(saved.body, { version: '1.4', at: 1_700_000_000_000 });
  assert.deepEqual((await call('/consent', { user: 'ana' })).body, saved.body);
  assert.equal((await call('/consent', { user: 'bia' })).body.version, null);
  assert.equal((await call('/consent', { user: 'ana', method: 'POST', body: {} })).status, 400);
});

test('area, member, author-delete and log routes are owner only', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  member(store, 'gil', areas.compras, 'gestor');
  const mine = (path, method, body) => call(path, { user: 'gil', method, body });
  for (const [path, method, body] of [
    ['/manage/areas', 'GET'],
    ['/manage/areas', 'POST', { name: 'Nova' }],
    [`/manage/areas/${areas.compras}`, 'PATCH', { name: 'X' }],
    [`/manage/areas/${areas.compras}`, 'DELETE'],
    ['/manage/members/bia', 'PUT', { memberships: [] }],
    ['/manage/authors/ana/facts', 'DELETE'],
    ['/manage/log', 'GET'],
  ]) {
    assert.equal((await mine(path, method, body)).status, 403, `${method} ${path}`);
  }
  fact(areas.compras, 'Fato da ana');
  assert.equal((await call('/manage/areas', { method: 'POST', body: { name: 'Nova' } })).status, 201);
  assert.equal(
    (await call(`/manage/areas/${areas.frota}`, { method: 'PATCH', body: { name: 'Frota 2' } })).body.area.name,
    'Frota 2'
  );
  assert.equal((await call('/manage/areas')).body.areas.length, 5);
  assert.equal((await call(`/manage/areas/${areas.frota}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call('/manage/authors/ana/facts', { method: 'DELETE' })).body.deleted, 1);
  const log = (await call('/manage/log')).body.log;
  assert.ok(log.some((entry) => entry.action === 'delete_author_facts'));
});

test('manager listing is limited to managed areas and filters', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  member(store, 'gil', areas.compras, 'gestor');
  fact(areas.compras, 'Compras alto', { risk: 'high', kind: 'regra' });
  const suspended = fact(areas.compras, 'Compras baixo');
  store.facts.update(suspended, { suspended: true }, 'gil');
  fact(areas.frota, 'Frota qualquer');
  const list = async (query, user = 'gil') => (await call(`/manage/facts${query}`, { user })).body.facts;
  assert.deepEqual((await list('')).map((f) => f.text).toSorted(), ['Compras alto', 'Compras baixo']);
  assert.equal((await list('?risk=high')).length, 1);
  assert.equal((await list('?kind=regra')).length, 1);
  assert.equal((await list('?suspended=true'))[0].text, 'Compras baixo');
  assert.equal((await list('?q=ALTO')).length, 1);
  assert.equal((await call(`/manage/facts?areaId=${areas.frota}`, { user: 'gil' })).status, 403);
  assert.equal((await list('', 'owner')).length, 3);
  const history = await call(`/manage/facts/${suspended}/history`, { user: 'gil' });
  assert.equal(history.body.history.length, 1);
  assert.equal((await call(`/manage/facts/${suspended}/history`, { user: 'hal' })).status, 404);
});

test('gestores get facts without author and conversation; the owner gets both; the quote stays', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  member(store, 'gil', areas.compras, 'gestor');
  const id = fact(areas.compras, 'Compras usa o portal novo', {
    sourceQuote: 'usa o portal novo',
    conversationRef: 'abc123',
  });
  const [seen] = (await call('/manage/facts', { user: 'gil' })).body.facts;
  assert.equal(seen.sourceQuote, 'usa o portal novo');
  assert.equal('authorUserId' in seen, false);
  assert.equal('conversationRef' in seen, false);
  const [history] = (await call(`/manage/facts/${id}/history`, { user: 'gil' })).body.history;
  assert.equal('authorUserId' in history, false);
  assert.equal('conversationRef' in history, false);
  const patched = (await call(`/manage/facts/${id}`, { method: 'PATCH', user: 'gil', body: { active: true } })).body
    .fact;
  assert.equal('authorUserId' in patched, false);
  assert.equal('conversationRef' in patched, false);
  const [owner] = (await call('/manage/facts', { user: 'owner' })).body.facts;
  assert.equal(owner.authorUserId, 'ana');
  assert.equal(owner.conversationRef, 'abc123');
});

test('x-jr-role owner/admin on a non-owner id grants nothing', async (t) => {
  const { call, areas, fact } = await startBrain(t);
  const id = fact(areas.compras, 'Fato de compras', { risk: 'high' });
  for (const role of ['owner', 'admin']) {
    assert.equal((await call('/manage/facts', { user: 'eve', role })).status, 403);
    assert.equal((await call('/manage/areas', { user: 'eve', role })).status, 403);
    assert.equal((await call('/manage/log', { user: 'eve', role })).status, 403);
    assert.equal(
      (await call(`/manage/facts/${id}`, { user: 'eve', role, method: 'PATCH', body: { active: false } })).status,
      404
    );
    const me = await call('/me', { user: 'eve', role });
    assert.equal(me.body.isDirector, false);
  }
});

test('colaborador gets 404 on history of a high fact', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  member(store, 'col', areas.compras);
  const id = fact(areas.compras, 'Fato alto', { risk: 'high' });
  assert.equal((await call(`/manage/facts/${id}/history`, { user: 'col' })).status, 404);
});

test('a Geral gestor (non-owner) manages nothing in Geral', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  member(store, 'gg', areas.general, 'gestor');
  const id = fact(areas.general, 'Regra geral da empresa');
  assert.equal(
    (await call(`/manage/facts/${id}`, { user: 'gg', method: 'PATCH', body: { text: 'Regra nova geral' } })).status,
    404
  );
  assert.equal((await call('/manage/facts', { user: 'gg' })).status, 403);
  assert.equal(
    (await call(`/manage/facts/${id}`, { method: 'PATCH', body: { text: 'Regra nova geral' } })).status,
    409
  );
});

test('manager filters apply before the 200 cap', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  member(store, 'gil', areas.compras, 'gestor');
  fact(areas.compras, 'Agulha no palheiro unica', { kind: 'regra' });
  for (let i = 0; i < 210; i += 1) fact(areas.compras, `Fato comum numero ${i}`);
  const q = await call('/manage/facts?q=agulha', { user: 'gil' });
  assert.equal(q.body.facts.length, 1);
  assert.equal((await call('/manage/facts?kind=regra', { user: 'gil' })).body.facts.length, 1);
  assert.equal((await call('/manage/facts', { user: 'gil' })).body.facts.length, 200);
  assert.equal((await call('/manage/facts?q=100%25', { user: 'gil' })).body.facts.length, 0);
});

test('read_high is logged for manager list, history and PATCH, deduped, non-owner only', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  member(store, 'gil', areas.compras, 'gestor');
  const id = fact(areas.compras, 'Contrato alto', { risk: 'high' });
  fact(areas.compras, 'Fato baixo');
  const reads = () => store.log.list().filter((entry) => entry.action === 'read_high');
  await call('/manage/facts', { user: 'gil' });
  assert.deepEqual(
    reads().map((e) => [e.userId, e.factId]),
    [['gil', id]]
  );
  await call(`/manage/facts/${id}/history`, { user: 'gil' });
  assert.equal(reads().length, 2);
  await call(`/manage/facts/${id}`, { user: 'gil', method: 'PATCH', body: { active: true } });
  assert.equal(reads().length, 3);
  await call('/manage/facts');
  await call('/search', { method: 'POST', body: { query: 'contrato' } });
  assert.equal(reads().length, 3);
});

test('legacy capture cannot trigger an async curator rejection and the log view stays capped newest first', async (t) => {
  let calls = 0;
  const curator = {
    enqueue: async () => {
      calls += 1;
      throw new Error('async boom');
    },
    drain: async () => {},
  };
  const { call, store } = await startBrain(t, { curator });
  assert.equal(
    (await call('/capture', { method: 'POST', body: { conversationRef: 'c', bot: 'b', messages: [] } })).status,
    503
  );
  assert.equal(calls, 0);
  for (let i = 0; i < 1100; i += 1) store.log.add({ userId: 'u', action: 'x', factId: i });
  const log = (await call('/manage/log')).body.log;
  assert.equal(log.length, 1000);
  assert.ok(log[0].id > log[1].id);
});

test('bad percent-encoding and invalid user ids give 400', async (t) => {
  const { call } = await startBrain(t);
  assert.equal((await call('/manage/authors/%E0%A4%A/facts', { method: 'DELETE' })).status, 400);
  assert.equal((await call('/manage/authors/a%20b/facts', { method: 'DELETE' })).status, 400);
  assert.equal((await call('/manage/members/%E0%A4%A', { method: 'PUT', body: { memberships: [] } })).status, 400);
});

test('daily curator budget of 0 is honored', async (t) => {
  const { store } = await startBrain(t, { dailyCuratorCalls: 0 });
  assert.equal(store.budget.take('2026-10-30'), false);
});

test('/me manages never lists Geral or the fallback area for a non-owner', async (t) => {
  const { call, store, areas } = await startBrain(t);
  member(store, 'gil', areas.compras, 'gestor');
  member(store, 'gil', areas.general, 'gestor', false);
  const me = (await call('/me', { user: 'gil' })).body;
  assert.deepEqual(me.manages, [areas.compras]);
  assert.ok(me.areas.some((a) => a.id === areas.general));
  const ownerManages = (await call('/me')).body.manages;
  assert.ok(ownerManages.includes(areas.general));
});
