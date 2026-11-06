import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { startBrain } from './support.mjs';

const SOURCE = 'A revisão da frota acontece toda sexta na oficina.';
const setup = async (t, options = {}) => {
  const seen = [];
  const brain = await startBrain(t, {
    curator: {
      async propose(identity, payload) {
        seen.push({ identity, payload });
        return {
          text: 'A revisão da frota acontece toda sexta.',
          sourceQuote: 'revisão da frota acontece toda sexta',
          sourceKind: 'usuario_afirmou',
          risk: 'low',
          areaId: brain.areas.frota,
        };
      },
      drain: async () => {},
    },
    ...options,
  });
  brain.store.members.set('ana', [{ areaId: brain.areas.frota, level: 'gestor', primary: true }]);
  brain.store.members.set('bia', [{ areaId: brain.areas.frota, level: 'colaborador', primary: true }]);
  brain.store.members.set('caio', [{ areaId: brain.areas.compras, level: 'gestor', primary: true }]);
  const proposal = async (extra = {}) =>
    brain.call('/proposals', {
      method: 'POST',
      user: 'ana',
      body: {
        requestId: randomUUID(),
        authorized: true,
        messages: [{ role: 'user', text: SOURCE }],
        ...extra,
      },
    });
  const revise = async (value, patch = {}) =>
    brain.call(`/proposals/${value.id}`, {
      method: 'PATCH',
      user: 'ana',
      body: {
        version: value.version,
        text: value.text,
        sourceQuote: value.sourceQuote,
        areaId: value.areaId,
        kind: value.kind,
        ...patch,
      },
    });
  const consent = async (value, decision = 'share', extra = {}) =>
    brain.call(`/proposals/${value.id}/consent`, {
      method: 'POST',
      user: 'ana',
      body: { version: value.version, hash: value.hash, decision, ...extra },
    });
  const search = async (user = 'bia') =>
    brain.call('/search', { method: 'POST', user, body: { query: 'revisão frota' } });
  return { ...brain, proposal, revise, consent, search, seen };
};

test('legacy capture does not analyze or publish a conversation', async (t) => {
  const b = await setup(t);
  const result = await b.call('/capture', {
    user: 'ana',
    method: 'POST',
    body: { messages: [{ role: 'user', text: SOURCE }] },
  });
  assert.deepEqual([result.status, result.body.error.code], [503, 'consent_required']);
  assert.equal(b.seen.length, 0);
  assert.equal(b.store.facts.listForManager({ all: true }).length, 0);
});

test('only an explicitly authorized excerpt generates a private draft', async (t) => {
  const b = await setup(t);
  assert.equal((await b.proposal({ authorized: false })).status, 400);
  const created = await b.proposal();
  assert.equal(created.body.proposal.status, 'draft');
  assert.deepEqual(
    b.seen.map((entry) => entry.payload.messages),
    [[{ role: 'user', text: SOURCE }]]
  );
  assert.equal(b.store.facts.listForManager({ all: true }).length, 0);
  assert.deepEqual((await b.call('/proposals', { user: 'bia' })).body.proposals, []);
});

test('declining sharing never creates a shared note', async (t) => {
  const b = await setup(t);
  const created = (await b.proposal()).body.proposal;
  assert.equal((await b.consent(created, 'discard')).body.proposal.status, 'rejected');
  assert.equal(b.store.facts.listForManager({ all: true }).length, 0);
  assert.equal((await b.consent(created)).status, 409);
});

test('approval binds exact revised version, authorized source and audience', async (t) => {
  const b = await setup(t);
  const created = (await b.proposal()).body.proposal;
  assert.equal((await b.revise(created, { sourceQuote: 'source outside the authorized excerpt' })).status, 400);
  const revised = (await b.revise(created, { text: 'Revisar a frota toda sexta na oficina.' })).body.proposal;
  assert.equal((await b.consent(created)).body.error.code, 'consent_mismatch');
  assert.equal((await b.consent(revised)).body.proposal.status, 'active');
  assert.equal((await b.search()).body.facts.length, 1);
  assert.deepEqual((await b.search('caio')).body.facts, []);
});

test('publishing the same approved version is idempotent and preserves only authorized citation', async (t) => {
  const b = await setup(t);
  const proposal = (await b.proposal()).body.proposal;
  const first = await b.consent(proposal);
  const second = await b.consent(proposal);
  assert.equal(first.body.fact.id, second.body.fact.id);
  assert.equal(b.store.facts.listForManager({ all: true }).length, 1);
  assert.equal((await b.search()).body.facts[0].sourceQuote, proposal.sourceQuote);
});

test('publication and approval preserve proved ERP identities after the JR account is relinked', async (t) => {
  let employeeErpId = 'erp-first-account';
  const b = await setup(t, {
    resolveAuthorization: async (identity) => ({
      jrUserId: identity.userId,
      erpUserId: identity.userId === 'ana' ? employeeErpId : 'erp-reviewer',
      organizationId: 'jr',
      scope: { all: true },
      publishAreaIds: b.store.areas.list().map((area) => area.id),
      reviewAreaIds: b.store.areas.list().map((area) => area.id),
    }),
  });
  const draft = (await b.proposal()).body.proposal;
  const shared = await b.consent(draft);
  employeeErpId = 'erp-relinked-account';
  assert.equal(b.store.facts.get(shared.body.fact.id).authorErpUserId, 'erp-first-account');
  assert.equal((await b.consent(draft)).status, 403);
  const next = (await b.proposal()).body.proposal;
  const official = (await b.revise(next, { kind: 'official_procedure' })).body.proposal;
  await b.consent(official);
  const approved = await b.call(`/manage/proposals/${official.id}/review`, {
    method: 'POST',
    body: { version: official.version, decision: 'approve' },
  });
  assert.equal(b.store.facts.get(approved.body.fact.id).approvedErpUserId, 'erp-reviewer');
});

test('official procedure is excluded until authorized approval; rejection never publishes it', async (t) => {
  const b = await setup(t);
  const created = (await b.proposal()).body.proposal;
  const official = (await b.revise(created, { kind: 'official_procedure' })).body.proposal;
  assert.equal((await b.consent(official)).body.proposal.status, 'pending_review');
  assert.deepEqual((await b.search()).body.facts, []);
  assert.equal(
    (
      await b.call(`/manage/proposals/${official.id}/review`, {
        method: 'POST',
        user: 'caio',
        body: { version: official.version, decision: 'approve' },
      })
    ).status,
    404
  );
  assert.equal(
    (
      await b.call(`/manage/proposals/${official.id}/review`, {
        method: 'POST',
        body: { version: official.version, decision: 'reject' },
      })
    ).body.proposal.status,
    'rejected'
  );
  assert.deepEqual((await b.search()).body.facts, []);
});

test('official approval activates only the reviewed version', async (t) => {
  const b = await setup(t);
  const created = (await b.proposal()).body.proposal;
  const official = (await b.revise(created, { kind: 'official_procedure' })).body.proposal;
  await b.consent(official);
  const result = await b.call(`/manage/proposals/${official.id}/review`, {
    method: 'POST',
    body: { version: official.version, decision: 'approve' },
  });
  assert.equal(result.body.fact.status, 'active');
  assert.equal((await b.search()).body.facts[0].noteType, 'official_procedure');
});

test('editing an active note creates a private new revision and retires old only after consent', async (t) => {
  const b = await setup(t);
  const first = await b.consent((await b.proposal()).body.proposal);
  const draft = await b.proposal({ factId: first.body.fact.id });
  const revised = (await b.revise(draft.body.proposal, { text: 'Revisão da frota na oficina toda sexta.' })).body
    .proposal;
  assert.equal((await b.search()).body.facts[0].text, first.body.fact.text);
  const next = await b.consent(revised);
  assert.equal(b.store.facts.get(first.body.fact.id).status, 'superseded');
  assert.deepEqual(
    (await b.search()).body.facts.map((fact) => fact.id),
    [next.body.fact.id]
  );
  assert.equal(b.store.facts.history(next.body.fact.id, { all: true }).length, 2);
});

test('legacy manager PATCH cannot bypass content consent or official review', async (t) => {
  const b = await setup(t);
  const shared = await b.consent((await b.proposal()).body.proposal);
  assert.equal(
    (
      await b.call(`/manage/facts/${shared.body.fact.id}`, {
        method: 'PATCH',
        body: { text: 'Revisão alterada sem consentimento.' },
      })
    ).body.error.code,
    'consent_required'
  );
  const official = (await b.revise((await b.proposal()).body.proposal, { kind: 'official_procedure' })).body.proposal;
  const pending = await b.consent(official);
  assert.equal(
    (await b.call(`/manage/facts/${pending.body.fact.id}`, { method: 'PATCH', body: { active: true } })).status,
    409
  );
});

test('missing ERP authorization blocks sharing, search, feedback and manager content even for owner', async (t) => {
  const b = await setup(t, { resolveAuthorization: null });
  const proposal = (await b.proposal()).body.proposal;
  assert.equal((await b.consent(proposal)).body.error.code, 'authorization_failed');
  for (const [path, method, body] of [
    ['/search', 'POST', { query: 'frota' }],
    ['/manage/facts', 'GET'],
    ['/manage/facts/1/history', 'GET'],
    ['/feedback', 'POST', { factId: 1 }],
  ]) {
    const result = await b.call(path, { method, body });
    assert.deepEqual([result.status, result.body.error.code], [403, 'authorization_failed']);
    assert.ok(!JSON.stringify(result.body).includes(SOURCE));
  }
});

test('ERP tenant mismatch and resolver failure fail closed before content lookup', async (t) => {
  const b = await setup(t, {
    resolveAuthorization: async (identity) => ({
      jrUserId: identity.userId,
      erpUserId: 'erp_ana',
      organizationId: 'other',
      scope: { all: true },
      publishAreaIds: [],
      reviewAreaIds: [],
    }),
  });
  assert.equal((await b.search()).body.error.code, 'authorization_failed');
  const broken = await setup(t, {
    resolveAuthorization: async () => {
      throw new Error(SOURCE);
    },
  });
  assert.equal((await broken.search()).body.error.code, 'authorization_failed');
});

test('diagnostics distinguish disabled extraction and never store arbitrary content metadata', async (t) => {
  const b = await startBrain(t, { log: () => {} });
  const requestId = randomUUID();
  const result = await b.call('/proposals', {
    method: 'POST',
    body: { requestId, authorized: true, messages: [{ role: 'user', text: SOURCE }] },
  });
  assert.deepEqual([result.status, result.body.error.code], [503, 'curator_disabled']);
  const events = (await b.call('/manage/diagnostics')).body.events;
  assert.ok(events.some((event) => event.event === 'curator_disabled' && event.correlationId === requestId));
  assert.ok(!JSON.stringify(events).includes(SOURCE));
});

test('review permission for an area alone never exposes high-risk procedures', async (t) => {
  let restricted = false;
  let b;
  b = await setup(t, {
    resolveAuthorization: async (identity) => ({
      jrUserId: identity.userId,
      erpUserId: 'erp_user',
      organizationId: 'jr',
      scope: restricted ? { low: [b.areas.frota], high: [] } : { all: true },
      publishAreaIds: [b.areas.frota],
      reviewAreaIds: [b.areas.frota],
    }),
  });
  const draft = (await b.proposal()).body.proposal;
  const official = (
    await b.revise(draft, { text: 'O orçamento da revisão da frota deve ser validado.', kind: 'official_procedure' })
  ).body.proposal;
  await b.consent(official);
  restricted = true;
  assert.deepEqual((await b.call('/manage/proposals')).body.proposals, []);
  for (const decision of ['approve', 'reject'])
    assert.equal(
      (
        await b.call(`/manage/proposals/${official.id}/review`, {
          method: 'POST',
          body: { version: official.version, decision },
        })
      ).status,
      404
    );
});

test('pending and rejected procedures cannot bypass approval via legacy suspension toggles or feedback', async (t) => {
  const b = await setup(t);
  const draft = (await b.proposal()).body.proposal;
  const official = (await b.revise(draft, { kind: 'official_procedure' })).body.proposal;
  const pending = await b.consent(official);
  for (const body of [{ suspended: true }, { active: true, suspended: false }])
    assert.equal((await b.call(`/manage/facts/${pending.body.fact.id}`, { method: 'PATCH', body })).status, 409);
  assert.equal((await b.call('/feedback', { method: 'POST', body: { factId: pending.body.fact.id } })).status, 404);
  assert.deepEqual((await b.search()).body.facts, []);
});

test('active toggle updates the operational status and suspension flag consistently', async (t) => {
  const b = await setup(t);
  const note = await b.consent((await b.proposal()).body.proposal);
  await b.call(`/manage/facts/${note.body.fact.id}`, { method: 'PATCH', body: { active: false } });
  assert.deepEqual((await b.search()).body.facts, []);
  await b.call(`/manage/facts/${note.body.fact.id}`, { method: 'PATCH', body: { active: true } });
  assert.equal((await b.search()).body.facts.length, 1);
});

test('copied drafts cannot survive revoked source access or move source content to another audience', async (t) => {
  let revoked = false;
  let b;
  b = await setup(t, {
    resolveAuthorization: async (identity) => ({
      jrUserId: identity.userId,
      erpUserId: 'erp_user',
      organizationId: 'jr',
      scope: revoked ? { low: [b.areas.compras], high: [] } : { all: true },
      publishAreaIds: [b.areas.frota, b.areas.compras],
      reviewAreaIds: [b.areas.frota, b.areas.compras],
    }),
  });
  const original = await b.consent((await b.proposal()).body.proposal);
  const copied = (await b.proposal({ factId: original.body.fact.id })).body.proposal;
  assert.equal((await b.revise(copied, { areaId: b.areas.compras })).status, 403);
  revoked = true;
  assert.ok(
    !(await b.call('/proposals', { user: 'ana' })).body.proposals.some((proposal) => proposal.id === copied.id)
  );
  assert.equal((await b.revise(copied)).status, 404);
  assert.equal((await b.consent(copied)).status, 404);
});

test('validity dates are part of approval and exclude future and expired notes before retrieval', async (t) => {
  const now = Date.now();
  const b = await setup(t, { now: () => now });
  const draft = (await b.proposal()).body.proposal;
  const future = (await b.revise(draft, { validFrom: now + 10000, validUntil: now + 20000 })).body.proposal;
  assert.equal((await b.consent(draft)).status, 409);
  await b.consent(future);
  assert.deepEqual((await b.search()).body.facts, []);
  const expired = (
    await b.revise((await b.proposal()).body.proposal, { validFrom: now - 20000, validUntil: now - 10000 })
  ).body.proposal;
  await b.consent(expired);
  assert.deepEqual((await b.search()).body.facts, []);
});

test('external correlation values must be opaque UUIDs and never reach diagnostic logs otherwise', async (t) => {
  const b = await setup(t);
  const requestId = 'sensitive_external_value';
  assert.equal((await b.proposal({ requestId })).status, 400);
  assert.ok(!JSON.stringify(b.store.diagnostics.list()).includes(requestId));
});
