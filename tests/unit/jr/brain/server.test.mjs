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
  assert.deepEqual(Object.keys(body.facts[0]).sort(), ['area', 'confidence', 'date', 'erpRef', 'id', 'risk', 'text']);
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

test('colaborador cannot PATCH; gestor patches only their own area', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  const compras = fact(areas.compras, 'Compras fecha pedidos na sexta');
  const frota = fact(areas.frota, 'Frota revisa caminhoes no mes');
  member(store, 'col', areas.compras);
  member(store, 'gil', areas.compras, 'gestor');
  const patch = (user, id, body) => call(`/manage/facts/${id}`, { method: 'PATCH', user, body });
  assert.equal((await patch('col', compras, { text: 'x y z' })).status, 404);
  assert.equal((await patch('gil', frota, { suspended: true })).status, 404);
  const ok = await patch('gil', compras, { text: 'Compras fecha pedidos na quinta' });
  assert.equal(ok.status, 200);
  assert.equal(store.facts.get(compras).text, 'Compras fecha pedidos na quinta');
  assert.equal(store.facts.get(frota).suspended, false);
  assert.equal((await call('/manage/facts', { user: 'col' })).status, 403);
});

test('owner demotes high to low and a colaborador then sees it; promoting back hides it', async (t) => {
  const { call, store, areas, fact } = await startBrain(t);
  const id = fact(areas.compras, 'Desconto maximo ao cliente e de cinco por cento', { risk: 'high' });
  member(store, 'col', areas.compras);
  const search = () => call('/search', { user: 'col', method: 'POST', body: { query: 'desconto cliente' } });
  assert.equal((await search()).body.facts.length, 0);
  assert.equal((await call(`/manage/facts/${id}`, { method: 'PATCH', body: { risk: 'low' } })).status, 200);
  assert.equal((await search()).body.facts.length, 1);
  assert.equal((await call(`/manage/facts/${id}`, { method: 'PATCH', body: { risk: 'high' } })).status, 200);
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

test('PATCH validation: nulls, secrets, risk/area rules, supersession chains', async (t) => {
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
  assert.deepEqual([secret.status, secret.body.error.code], [400, 'secret']);

  // moving needs management of both source and target
  assert.equal((await patch('hal', id, { areaId: areas.frota })).status, 403);
  assert.equal((await patch('gil', id, { areaId: areas.frota })).status, 200);
  assert.equal(store.facts.get(id).areaId, areas.frota);

  // promote to Geral: low only; high is refused
  const high = fact(areas.compras, 'Salario do cargo de comprador', { risk: 'high' });
  const promoteHigh = await patch('hal', high, { general: true });
  assert.deepEqual([promoteHigh.status, promoteHigh.body.error.code], [400, 'promote_requires_low']);
  const low = fact(areas.compras, 'Compras fica no segundo andar');
  assert.equal((await patch('hal', low, { general: true })).status, 200);
  assert.equal(store.facts.get(low).areaId, areas.general);
  assert.equal((await patch('hal', low, { text: 'Compras fica no terceiro andar' })).status, 404);

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
    assert.deepEqual([moved.status, moved.body.error.code], [409, 'in_supersession_chain']);
  }
  assert.equal((await patch('owner', next, { text: 'Prazo de pagamento padrao e quarenta e cinco dias' })).status, 200);
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
    peers.body.peers.sort((a, b) => a.userId.localeCompare(b.userId)),
    [
      { userId: 'fro', areas: [{ areaId: areas.frota, level: 'colaborador' }] },
      { userId: 'gil', areas: [{ areaId: areas.compras, level: 'colaborador' }] },
    ]
  );
});

test('capture returns 202, hands off to the curator and persists no raw text', async (t) => {
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
  assert.equal(status, 202);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].identity.userId, 'ana');
  assert.equal(seen[0].payload.messages[0].text, marker);
  store.log.add({ userId: 'x', action: 'noop' });
  for (const file of await readdir(directory)) {
    assert.ok(!(await readFile(join(directory, file))).includes(marker), `${file} holds raw text`);
  }
  const bad = await call('/capture', {
    method: 'POST',
    body: { conversationRef: 'c', bot: 'b', messages: [{ role: 'x', text: 'y' }] },
  });
  assert.equal(bad.status, 400);
});

test('capture failure in the curator is dropped silently', async (t) => {
  const curator = {
    enqueue: () => {
      throw new Error('boom');
    },
    drain: async () => {},
  };
  const { call } = await startBrain(t, { curator });
  const { status } = await call('/capture', { method: 'POST', body: { conversationRef: 'c', bot: 'b', messages: [] } });
  assert.equal(status, 202);
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
  assert.deepEqual((await list('')).map((f) => f.text).sort(), ['Compras alto', 'Compras baixo']);
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
