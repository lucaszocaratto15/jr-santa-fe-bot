import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createStrataBrainAuthorization } from '../../../../services/brain/access.mjs';
import { createBrainStore } from '../../../../services/brain/store.mjs';
import { brainPrincipalProof } from '../../../../services/control/brain.mjs';
import { startBrain, SECRET } from './support.mjs';

const group = {
  id: 'group-jr',
  name: 'Grupo JR',
  organizations: [
    { id: 'org-a', name: 'Empresa A' },
    { id: 'org-b', name: 'Empresa B' },
  ],
};
const capabilities = { read: true, publish: false, revise: false, withdraw: false, approveOfficial: false };
const audiences = [
  { key: 'empresa', label: 'Empresa', read: true, publish: false, review: false },
  { key: 'modulo:frota', label: 'Frota', read: true, publish: false, review: false },
];

async function setup(t) {
  const now = Date.now();
  const brain = await startBrain(t, {
    now: () => now,
    erpAuthorization: true,
    resolveAuthorization: createStrataBrainAuthorization(SECRET, () => now),
  });
  const stores = new Map(
    ['org-a', 'org-b', 'foreign'].map((companyId) => {
      const store = createBrainStore(join(brain.directory, 'brain.sqlite'), { companyId, now: () => now });
      const labels = store.areas.syncErpAudiences([
        ...audiences,
        { key: 'modulo:financeiro', label: 'Financeiro', read: true, publish: false, review: false },
      ]);
      return [companyId, { store, labels }];
    })
  );
  t.after(() => {
    for (const { store } of stores.values()) store.close();
  });
  const fact = (company, text, key = 'modulo:frota', extra = {}) =>
    stores.get(company).store.facts.insert({
      areaId: stores.get(company).labels.find((area) => area.erpAudienceKey === key).id,
      text,
      sourceQuote: text,
      risk: 'low',
      sourceKind: 'usuario_afirmou',
      authorUserId: 'ana',
      authorErpUserId: 'erp-ana',
      confidence: 9,
      noteId: randomUUID(),
      consentHash: 'explicit-test-consent',
      ...extra,
    });
  const call = (path, body, { organization = 'org-a', policy = {}, headers = {} } = {}) => {
    const principal = {
      jrUserId: 'bia',
      erpUserId: 'erp-bia',
      organizationId: organization,
      knowledgePolicy: {
        policy_version: 1,
        user_id: 'erp-bia',
        organization_id: organization,
        capabilities,
        audiences,
        group,
        ...policy,
      },
    };
    const proof = brainPrincipalProof(SECRET, { id: 'bia' }, principal, 'POST', path, body, () => now);
    return brain.call(path, {
      user: 'bia',
      method: 'POST',
      body,
      headers: { 'x-brain-erp-context': proof, ...headers },
    });
  };
  return { ...brain, stores, fact, call, now };
}

test('one SQL search ranks the group and excludes forbidden rows before candidates reach the model', async (t) => {
  const b = await setup(t);
  const a = b.fact('org-a', 'Alvo permitido A');
  const second = b.fact('org-b', 'Alvo permitido B');
  for (let n = 0; n < 205; n++) b.fact('org-b', `Alvo financeiro secreto ${n}`, 'modulo:financeiro');
  b.fact('foreign', 'Alvo de outro grupo');
  b.fact('org-b', 'Alvo legado', 'modulo:frota', { authorErpUserId: null });
  b.fact('org-b', 'Alvo sem consentimento', 'modulo:frota', { consentHash: null });
  const candidates = [];
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (sql.includes('brain_facts_fts MATCH')) {
      const all = statement.all;
      statement.all = function (...params) {
        const rows = all.apply(this, params);
        candidates.push(rows);
        return rows;
      };
    }
    return statement;
  };
  let result;
  try {
    result = await b.call('/search', { query: 'Alvo', organization_id: 'foreign', limit: 5 });
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.deepEqual(
    candidates.map((rows) => rows.map((row) => row.id).sort((x, y) => x - y)),
    [[a, second]]
  );
  assert.deepEqual(
    result.body.facts.map((item) => [item.id, item.organizationId, item.area]),
    [
      [a, 'org-a', 'Frota · Empresa A'],
      [second, 'org-b', 'Frota · Empresa B'],
    ]
  );
  assert.deepEqual(result.body.searchScope, { type: 'group', groupId: 'group-jr', companyCount: 2 });
});

test('changing the selected company does not change group results or the global limit', async (t) => {
  const b = await setup(t);
  for (const company of ['org-a', 'org-b'])
    for (let n = 0; n < 4; n++) b.fact(company, `Limite comum nota ${n} ${company}`);
  const fromA = await b.call('/search', { query: 'Limite', limit: 3 });
  const fromB = await b.call('/search', { query: 'Limite', limit: 3 }, { organization: 'org-b' });
  assert.deepEqual(fromB.body, fromA.body);
  assert.equal(fromA.body.facts.length, 3);
  const bounded = await b.call('/search', { query: 'Limite', maxChars: 50 });
  assert.ok(bounded.body.facts.reduce((sum, item) => sum + item.text.length, 0) <= 50);
});

test('group search excludes expired, future, rejected, superseded and unapproved official notes', async (t) => {
  const b = await setup(t);
  const current = b.fact('org-b', 'Vigente disponível');
  for (const extra of [
    { validUntil: b.now - 1, validFrom: b.now - 1000 },
    { validFrom: b.now + 1000 },
    { status: 'rejected' },
    { noteType: 'official_procedure' },
  ])
    b.fact('org-b', 'Vigente restrito', 'modulo:frota', extra);
  const old = b.fact('org-a', 'Vigente antigo');
  b.stores.get('org-a').store.facts.supersede(old, {
    areaId: b.stores.get('org-a').labels[1].id,
    text: 'Sem correspondência',
    risk: 'low',
    sourceKind: 'usuario_afirmou',
    authorUserId: 'ana',
    confidence: 9,
  });
  const found = await b.call('/search', { query: 'Vigente' });
  assert.deepEqual(
    found.body.facts.map((item) => item.id),
    [current]
  );
});

test('group module revocation and group removal stop reads and feedback', async (t) => {
  const b = await setup(t);
  const id = b.fact('org-b', 'Revogação frota');
  const noFleet = { audiences: [audiences[0]] };
  assert.deepEqual((await b.call('/search', { query: 'Revogação' }, { policy: noFleet })).body.facts, []);
  assert.equal((await b.call('/feedback', { factId: id }, { policy: noFleet })).status, 404);
  const removed = { group: { ...group, organizations: [group.organizations[0]] } };
  assert.deepEqual((await b.call('/search', { query: 'Revogação' }, { policy: removed })).body.facts, []);
});

test('feedback on an authorized group result keeps its real source and confidence penalty', async (t) => {
  const b = await setup(t);
  const id = b.fact('org-b', 'Correção de frota');
  assert.equal((await b.call('/feedback', { factId: id })).status, 200);
  const found = await b.call('/search', { query: 'Correção' });
  assert.deepEqual([found.body.facts[0].organizationId, found.body.facts[0].confidence], ['org-b', 6]);
  assert.equal(b.stores.get('org-b').store.facts.get(id).status, 'active');
});

test('signed malformed group scopes fail before reading any fact', async (t) => {
  const b = await setup(t);
  b.fact('org-a', 'Segredo');
  for (const invalid of [
    null,
    { ...group, organizations: [] },
    { ...group, organizations: [group.organizations[1]] },
    { ...group, organizations: [group.organizations[0], group.organizations[0]] },
  ]) {
    const result = await b.call('/search', { query: 'Segredo' }, { policy: { group: invalid } });
    assert.equal(result.status, 403);
    assert.equal(JSON.stringify(result.body).includes('Segredo'), false);
  }
});
