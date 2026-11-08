import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readScope } from '../../../../services/brain/access.mjs';
import { createBrainStore } from '../../../../services/brain/store.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 30);

function open(options = {}) {
  const clock = { t: T0 };
  const store = createBrainStore(':memory:', { now: () => clock.t, ...options });
  const [general] = store.areas.list();
  return { store, clock, general, frota: store.areas.create('Frota').id, compras: store.areas.create('Compras').id };
}

const fact = (areaId, text, extra = {}) => ({
  areaId,
  risk: 'low',
  kind: 'fato',
  text,
  sourceKind: 'usuario_afirmou',
  authorUserId: 'ana',
  confidence: 8,
  ...extra,
});

const lowScope = (...ids) => ({ low: new Set(ids), high: new Set() });

test('seeds Geral and Sem área and protects them', () => {
  const { store, general } = open();
  assert.deepEqual(
    store.areas.list().map((a) => [a.name, a.isGeneral]),
    [
      ['Geral', true],
      ['Compras', false],
      ['Frota', false],
      ['Sem área', false],
    ]
  );
  assert.throws(() => store.areas.rename(general.id, 'X'), /area_protected/);
  assert.throws(() => store.areas.remove(general.id), /area_protected/);
  assert.throws(() => store.areas.create('Geral'), /area_exists/);
});

test('search finds a fact ignoring accents and case', () => {
  const { store, general } = open();
  store.facts.insert(fact(general.id, 'Fornecedor X passou a cobrar frete'));
  store.facts.insert(fact(general.id, 'Outro assunto sem relacao'));
  const found = store.facts.search(lowScope(general.id), 'FRETE fornecedor x');
  assert.equal(found.length, 1);
  assert.equal(found[0].text, 'Fornecedor X passou a cobrar frete');
  assert.deepEqual(store.facts.search(lowScope(general.id), ''), []);
  assert.deepEqual(store.facts.search(lowScope(general.id), '"*" ) OR'), []);
});

test('scope: a colaborador never sees high; manager sees high of the managed area; owner sees all', () => {
  const { store, general, frota, compras } = open();
  store.facts.insert(fact(frota, 'Caminhao placa alpha custa caro', { risk: 'high' }));
  store.facts.insert(fact(frota, 'Caminhao placa beta revisao feita'));
  store.facts.insert(fact(compras, 'Caminhao compra de pecas', { risk: 'high' }));
  const colab = store.facts.search({ low: new Set([general.id, frota]), high: new Set() }, 'caminhao');
  assert.deepEqual(
    colab.map((f) => f.risk),
    ['low']
  );
  const gestor = store.facts.search({ low: new Set([general.id, frota, compras]), high: new Set([frota]) }, 'caminhao');
  assert.deepEqual(gestor.map((f) => f.text).toSorted(), [
    'Caminhao placa alpha custa caro',
    'Caminhao placa beta revisao feita',
  ]);
  assert.equal(store.facts.search({ all: true }, 'caminhao').length, 3);
  assert.equal(store.facts.search({ low: new Set(), high: new Set() }, 'caminhao').length, 0);
});

test('search returns at most 5 facts and 1500 characters', () => {
  const { store, general } = open();
  for (let i = 0; i < 9; i += 1) store.facts.insert(fact(general.id, `Regra de obra numero ${i}`));
  assert.equal(store.facts.search(lowScope(general.id), 'regra obra').length, 5);
  const big = open();
  for (let i = 0; i < 4; i += 1) big.store.facts.insert(fact(big.general.id, `lona ${'x'.repeat(590)}${i}`));
  const found = big.store.facts.search(lowScope(big.general.id), 'lona');
  assert.ok(found.reduce((n, f) => n + f.text.length, 0) <= 1500);
  assert.equal(found.length, 2);
});

test('suspended, inactive and superseded facts are excluded', () => {
  const { store, general } = open();
  const a = store.facts.insert(fact(general.id, 'palavra alfa um'));
  const b = store.facts.insert(fact(general.id, 'palavra alfa dois'));
  const c = store.facts.insert(fact(general.id, 'palavra alfa tres'));
  store.facts.insert(fact(general.id, 'palavra alfa quatro'));
  store.facts.update(a, { suspended: true }, 'gestor');
  store.facts.update(b, { active: false }, 'gestor');
  store.facts.supersede(c, fact(general.id, 'palavra alfa cinco'));
  const texts = store.facts
    .search(lowScope(general.id), 'alfa')
    .map((f) => f.text)
    .toSorted();
  assert.deepEqual(texts, ['palavra alfa cinco', 'palavra alfa quatro']);
});

test('recency: full for 30 days, decays, excluded when effective confidence < 3', () => {
  const { store, clock, general } = open();
  store.facts.insert(fact(general.id, 'regra antiga de teste', { confidence: 10 }));
  const search = () => store.facts.search(lowScope(general.id), 'antiga');
  clock.t = T0 + 30 * DAY;
  assert.equal(search()[0].confidence, 10);
  clock.t = T0 + 380 * DAY;
  assert.ok(Math.abs(search()[0].confidence - 5) < 0.01);
  clock.t = T0 + 800 * DAY;
  assert.deepEqual(search(), []);
});

test('feedback penalty lowers confidence; one vote per user per fact', () => {
  const { store, general } = open();
  const id = store.facts.insert(fact(general.id, 'dado discutivel', { confidence: 6 }));
  store.feedback.vote(id, 'bia', 2);
  store.feedback.vote(id, 'bia', 2);
  assert.equal(store.facts.search(lowScope(general.id), 'discutivel')[0].confidence, 4);
  store.feedback.vote(id, 'caio', 2);
  assert.deepEqual(store.facts.search(lowScope(general.id), 'discutivel'), []);
  store.feedback.vote(id, 'caio', 0, 'certo');
  assert.equal(store.facts.search(lowScope(general.id), 'discutivel')[0].confidence, 4);
});

test('supersede keeps the old row, links it, and only within the same risk', () => {
  const { store, general } = open();
  const first = store.facts.insert(fact(general.id, 'prazo era dez dias'));
  const second = store.facts.supersede(first, fact(general.id, 'prazo agora e cinco dias'));
  const third = store.facts.supersede(second, fact(general.id, 'prazo agora e tres dias'));
  assert.equal(store.facts.get(first).supersededBy, second);
  assert.deepEqual(
    store.facts.history(second).map((f) => f.id),
    [first, second, third]
  );
  assert.deepEqual(
    store.facts.history(third).map((f) => f.id),
    [first, second, third]
  );
  assert.throws(() => store.facts.supersede(third, fact(general.id, 'x', { risk: 'high' })), /risk_mismatch/);
  assert.equal(store.facts.get(third).supersededBy, null);
  assert.deepEqual(
    store.facts.search(lowScope(general.id), 'prazo').map((f) => f.id),
    [third]
  );
});

test('update rewrites the index, records who and when; flagConflict marks the fact', () => {
  const { store, clock, general } = open();
  const id = store.facts.insert(fact(general.id, 'texto original zebra'));
  clock.t += 1000;
  const updated = store.facts.update(id, { text: 'Texto novo girafa' }, 'gestor1');
  assert.equal(updated.updatedBy, 'gestor1');
  assert.equal(updated.updatedAt, clock.t);
  assert.equal(store.facts.search(lowScope(general.id), 'zebra').length, 0);
  assert.equal(store.facts.search(lowScope(general.id), 'girafa').length, 1);
  store.facts.flagConflict(id);
  assert.equal(store.facts.get(id).flagConflict, true);
  assert.throws(() => store.facts.update(999, {}, 'x'), /fact_not_found/);
});

test('listForManager respects scope and includes suspended facts', () => {
  const { store, general, frota, compras } = open();
  const a = store.facts.insert(fact(frota, 'um', { risk: 'high' }));
  store.facts.insert(fact(compras, 'dois', { risk: 'high' }));
  store.facts.insert(fact(general.id, 'tres'));
  store.facts.update(a, { suspended: true }, 'g');
  const scope = { low: new Set([general.id, frota, compras]), high: new Set([frota]) };
  assert.deepEqual(
    store.facts
      .listForManager(scope)
      .map((f) => f.text)
      .toSorted(),
    ['tres', 'um']
  );
  assert.deepEqual(
    store.facts.listForManager(scope, { flaggedOnly: true }).map((f) => f.text),
    ['um']
  );
  assert.equal(store.facts.listForManager({ all: true }, { areaId: compras }).length, 1);
});

test('deleteByAuthor removes only that author facts', () => {
  const { store, general } = open();
  const mine = store.facts.insert(fact(general.id, 'meu fato', { authorUserId: 'ana' }));
  store.facts.insert(fact(general.id, 'fato do outro meu', { authorUserId: 'bia' }));
  store.feedback.vote(mine, 'bia', 1);
  assert.equal(store.facts.deleteByAuthor('ana'), 1);
  assert.equal(store.facts.get(mine), null);
  assert.deepEqual(
    store.facts.search(lowScope(general.id), 'meu').map((f) => f.text),
    ['fato do outro meu']
  );
});

test('areas and members: set replaces, remove moves facts to Sem área and drops memberships', () => {
  const { store, general, frota, compras } = open();
  const fallback = store.areas.list().find((a) => a.name === 'Sem área').id;
  store.members.set('ana', [
    { areaId: frota, level: 'gestor', primary: true },
    { areaId: compras, level: 'colaborador', primary: false },
  ]);
  store.members.set('bia', [{ areaId: frota, level: 'colaborador', primary: true }]);
  assert.deepEqual(store.members.of('ana'), [
    { areaId: frota, level: 'gestor', primary: true },
    { areaId: compras, level: 'colaborador', primary: false },
  ]);
  assert.deepEqual(
    store.members.ofArea(frota).map((m) => m.userId),
    ['ana', 'bia']
  );
  assert.throws(() => store.members.set('ana', [{ areaId: 999, level: 'gestor', primary: false }]), /area_not_found/);
  assert.equal(store.members.of('ana').length, 2, 'failed set rolls back');
  assert.throws(
    () => store.members.set('ana', [{ areaId: frota, level: 'chefe', primary: false }]),
    /invalid_membership/
  );
  const id = store.facts.insert(fact(frota, 'fato da frota'));
  store.areas.rename(frota, 'Frota Pesada');
  store.areas.remove(frota);
  assert.equal(store.facts.get(id).areaId, fallback);
  assert.deepEqual(store.members.of('bia'), []);
  assert.ok(!store.areas.list().some((a) => a.id === frota));
  assert.ok(general.id);
});

test('budget.take stops after the daily limit and resets next day', () => {
  const { store } = open();
  for (let i = 0; i < 500; i += 1) assert.equal(store.budget.take('2026-10-30'), true);
  assert.equal(store.budget.take('2026-10-30'), false);
  assert.equal(store.budget.take('2026-10-31'), true);
  assert.equal(open({ dailyCuratorCalls: 1 }).store.budget.take('d'), true);
});

test('log keeps who/when/fact and prunes entries older than 90 days', () => {
  const { store, clock } = open();
  store.log.add({ userId: 'ana', action: 'read_high', factId: 1 });
  clock.t += 91 * DAY;
  store.log.add({ userId: 'bia', action: 'update', factId: 2 });
  assert.equal(store.log.list().length, 2);
  assert.equal(store.log.prune(), 1);
  assert.deepEqual(
    store.log.list().map((e) => [e.userId, e.action, e.factId]),
    [['bia', 'update', 2]]
  );
  assert.equal(store.log.list({ since: clock.t + 1 }).length, 0);
});

test('consent records the acknowledged notice version', () => {
  const { store, clock } = open();
  assert.equal(store.consent.latest('ana'), null);
  store.consent.record('ana', '1.3');
  clock.t += 1000;
  store.consent.record('ana', '1.4');
  assert.deepEqual(store.consent.latest('ana'), { version: '1.4', at: clock.t });
});

test('companies are isolated and file database is private', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brain-'));
  try {
    const path = join(dir, 'sub', 'brain.db');
    const jr = createBrainStore(path);
    const [general] = jr.areas.list();
    jr.facts.insert(fact(general.id, 'segredo de familia jr'));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const other = createBrainStore(path, { companyId: 'outra' });
    assert.equal(other.facts.search({ all: true }, 'familia').length, 0);
    assert.equal(jr.facts.search({ all: true }, 'familia').length, 1);
    jr.close();
    other.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removed areas: facts go to owner-only Sem área and former members cannot read them', () => {
  const { store, general, frota, compras } = open();
  const fallback = store.areas.fallbackId();
  store.members.set('ana', [{ areaId: frota, level: 'colaborador', primary: true }]);
  store.members.set('bia', [{ areaId: compras, level: 'colaborador', primary: true }]);
  const fa = store.facts.insert(fact(frota, 'segredo da frota antiga'));
  const fb = store.facts.insert(fact(compras, 'segredo de compras antigo'));
  assert.throws(
    () => store.members.set('ana', [{ areaId: fallback, level: 'colaborador', primary: false }]),
    /area_protected/
  );
  store.areas.remove(frota);
  store.areas.remove(compras);
  for (const user of ['ana', 'bia']) {
    const scope = readScope({ userId: user }, store.members.of(user), general.id, fallback);
    assert.equal(store.facts.search(scope, 'segredo').length, 0);
    assert.equal(store.facts.get(fa, scope), null);
    assert.equal(store.facts.get(fb, scope), null);
  }
  assert.equal(store.facts.search({ all: true }, 'segredo').length, 2);
  const stale = readScope(
    { userId: 'x' },
    [{ areaId: fallback, level: 'gestor', primary: true }],
    general.id,
    fallback
  );
  assert.deepEqual([...stale.low], [general.id]);
  assert.deepEqual([...stale.high], []);
});

test('get and history are scope-aware', () => {
  const { store, general, frota, compras } = open();
  const a = store.facts.insert(fact(frota, 'v1 frota'));
  const b = store.facts.supersede(a, fact(frota, 'v2 frota'));
  const c = store.facts.insert(fact(compras, 'v1 compras', { risk: 'high' }));
  const scope = { low: new Set([general.id, frota]), high: new Set() };
  assert.equal(store.facts.get(a, scope).id, a);
  assert.equal(store.facts.get(c, scope), null);
  assert.equal(store.facts.get(c).id, c);
  assert.deepEqual(
    store.facts.history(b, scope).map((f) => f.id),
    [a, b]
  );
  assert.deepEqual(store.facts.history(c, scope), []);
  assert.deepEqual(store.facts.history(a, { low: new Set([general.id]), high: new Set() }), []);
});

test('search returns a public projection only', () => {
  const { store, frota } = open();
  store.facts.insert(
    fact(frota, 'Fornecedor Z entrega rapido', {
      sourceQuote: 'quote',
      authorBot: 'bot',
      conversationRef: 'c1',
      erpRef: 'obra:1',
    })
  );
  const [found] = store.facts.search({ all: true }, 'fornecedor');
  assert.deepEqual(found, {
    id: found.id,
    companyId: 'jr',
    text: 'Fornecedor Z entrega rapido',
    kind: 'fato',
    area: 'Frota',
    risk: 'low',
    date: '2026-10-30',
    confidence: 8,
    erpRef: 'obra:1',
    noteType: 'shared_note',
    version: 1,
  });
  assert.equal('sourceQuote' in store.facts.listForManager({ all: true })[0], true);
});

test('deleteByAuthor makes superseded predecessors heads again', () => {
  const { store, general } = open();
  const old = store.facts.insert(fact(general.id, 'prazo velho', { authorUserId: 'bia' }));
  store.facts.supersede(old, fact(general.id, 'prazo novo', { authorUserId: 'ana' }));
  store.facts.deleteByAuthor('ana');
  assert.equal(store.facts.get(old).supersededBy, null);
  assert.deepEqual(
    store.facts.search(lowScope(general.id), 'prazo').map((f) => f.id),
    [old]
  );
});

test('feedback rows carry the company and do not leak across companies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brain-'));
  try {
    const path = join(dir, 'b.db');
    const jr = createBrainStore(path);
    const other = createBrainStore(path, { companyId: 'outra' });
    const id = jr.facts.insert(fact(jr.areas.list()[0].id, 'dado compartilhado'));
    assert.throws(() => other.feedback.vote(id, 'bia', 5), /fact_not_found/);
    jr.feedback.vote(id, 'bia', 2);
    assert.equal(jr.facts.search({ all: true }, 'compartilhado')[0].confidence, 6);
    jr.close();
    other.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('supersede rejects an already superseded fact and another area', () => {
  const { store, general, frota } = open();
  const a = store.facts.insert(fact(general.id, 'um'));
  store.facts.supersede(a, fact(general.id, 'dois'));
  assert.throws(() => store.facts.supersede(a, fact(general.id, 'tres')), /already_superseded/);
  const b = store.facts.insert(fact(general.id, 'quatro'));
  assert.throws(() => store.facts.supersede(b, fact(frota, 'cinco')), /area_mismatch/);
});

test('vote clamps negative weight and rejects unknown facts', () => {
  const { store, general } = open();
  const id = store.facts.insert(fact(general.id, 'fato votado', { confidence: 6 }));
  store.feedback.vote(id, 'bia', -5);
  assert.equal(store.facts.search(lowScope(general.id), 'votado')[0].confidence, 6);
  assert.throws(() => store.feedback.vote(999, 'bia', 1), /fact_not_found/);
});

test('update validates text, confidence, area and high-in-Geral', () => {
  const { store, general, frota } = open();
  const id = store.facts.insert(fact(frota, 'fato valido'));
  assert.throws(() => store.facts.update(id, { text: '   ' }, 'g'), /invalid_fact/);
  assert.throws(() => store.facts.update(id, { confidence: 11 }, 'g'), /invalid_fact/);
  assert.throws(() => store.facts.update(id, { confidence: -1 }, 'g'), /invalid_fact/);
  assert.throws(() => store.facts.update(id, { areaId: 999 }, 'g'), /area_not_found/);
  assert.throws(() => store.facts.update(id, { risk: 'high', areaId: general.id }, 'g'), /high_in_general/);
  store.facts.update(id, { risk: 'high' }, 'g');
  assert.throws(() => store.facts.update(id, { areaId: general.id }, 'g'), /high_in_general/);
  assert.equal(store.facts.get(id).areaId, frota);
});
