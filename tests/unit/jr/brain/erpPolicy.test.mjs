import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { brainPrincipalProof } from '../../../../services/control/brain.mjs';
import { createStrataBrainAuthorization } from '../../../../services/brain/access.mjs';
import { createBrainStore } from '../../../../services/brain/store.mjs';
import { join } from 'node:path';
import { startBrain, SECRET } from './support.mjs';

const SOURCE = 'A revisão da frota acontece toda sexta na oficina.';
const policy = (user, organization, rights = {}, audiences) => {
  const capabilities = { read: true, publish: true, revise: true, withdraw: true, approveOfficial: false, ...rights };
  return {
    policy_version: 1,
    user_id: `erp_${user}`,
    organization_id: organization,
    capabilities,
    audiences: audiences ?? [
      {
        key: 'empresa',
        label: 'Empresa ERP',
        read: capabilities.read,
        publish: capabilities.read && capabilities.publish,
        review: capabilities.read && capabilities.approveOfficial,
      },
    ],
  };
};

async function setup(t, options = {}) {
  const instant = Date.now();
  const seen = [];
  const brain = await startBrain(t, {
    now: () => instant,
    erpAuthorization: true,
    resolveAuthorization: createStrataBrainAuthorization(SECRET, () => instant),
    curator: {
      async propose(identity, payload) {
        seen.push({ identity, payload });
        return { text: SOURCE, sourceQuote: SOURCE, sourceKind: 'usuario_afirmou', risk: 'low', areaId: 9999 };
      },
      drain: async () => {},
    },
    ...options,
  });
  const call = (
    path,
    { user = 'ana', organization = 'org-a', rights, audiences, erpUserId, body, method = 'GET', ...rest } = {}
  ) => {
    const knowledgePolicy = policy(user, organization, rights, audiences);
    if (erpUserId) knowledgePolicy.user_id = erpUserId;
    const principal = {
      jrUserId: user,
      erpUserId: erpUserId ?? `erp_${user}`,
      organizationId: organization,
      knowledgePolicy,
    };
    const proof = brainPrincipalProof(SECRET, { id: user }, principal, method, path, body, () => instant);
    return brain.call(path, { method, body, user, headers: { 'x-brain-erp-context': proof }, ...rest });
  };
  const draft = async (extra = {}) =>
    call('/proposals', {
      method: 'POST',
      ...extra,
      body: { requestId: randomUUID(), authorized: true, messages: [{ role: 'user', text: SOURCE }], ...extra.body },
    });
  const share = (proposal, extra = {}) =>
    call(`/proposals/${proposal.id}/consent`, {
      method: 'POST',
      ...extra,
      body: { version: proposal.version, hash: proposal.hash, decision: 'share', ...extra.body },
    });
  const revise = (proposal, patch, extra = {}) =>
    call(`/proposals/${proposal.id}`, {
      method: 'PATCH',
      ...extra,
      body: {
        version: proposal.version,
        text: proposal.text,
        sourceQuote: proposal.sourceQuote,
        areaId: proposal.areaId,
        kind: proposal.kind,
        ...patch,
      },
    });
  const search = (extra = {}) => call('/search', { method: 'POST', body: { query: 'revisão frota' }, ...extra });
  return { ...brain, call, draft, share, revise, search, seen };
}

test('live ERP rights enable publication and search without any local JR memberships', async (t) => {
  const b = await setup(t);
  const created = await b.draft();
  assert.equal(created.status, 201);
  assert.deepEqual(
    created.body.audiences.map((item) => item.name),
    ['Empresa ERP']
  );
  assert.equal((await b.share(created.body.proposal)).status, 200);
  assert.equal((await b.search({ user: 'bia' })).body.facts[0].text, SOURCE);
  const me = (await b.call('/me')).body;
  assert.equal(me.permissionsSource, 'erp');
  assert.equal(me.isDirector, false);
});

test('JR owner and local gestor never override current ERP refusal', async (t) => {
  const b = await setup(t);
  b.store.members.set('owner', [{ areaId: b.areas.frota, level: 'gestor', primary: true }]);
  const result = await b.search({
    user: 'owner',
    rights: { read: false, publish: false, revise: false, withdraw: false, approveOfficial: false },
  });
  assert.deepEqual([result.status, result.body.error.code], [403, 'forbidden']);
  assert.equal((await b.draft({ user: 'owner', rights: { publish: false } })).status, 403);
  assert.equal(b.seen.length, 0);
});

test('ERP module audiences filter before search and never become a JR membership grant', async (t) => {
  const b = await setup(t);
  const audiences = [
    { key: 'empresa', label: 'Empresa ERP', read: true, publish: true, review: false },
    { key: 'modulo:frota', label: 'Frota ERP', read: true, publish: true, review: false },
  ];
  const created = (await b.draft({ audiences })).body;
  const areaId = created.audiences.find((item) => item.key === 'modulo:frota')?.id;
  const changed = (await b.revise(created.proposal, { areaId }, { audiences })).body.proposal;
  assert.equal((await b.share(changed, { audiences })).status, 200);
  const denied = audiences.map((item) =>
    item.key === 'modulo:frota' ? { ...item, read: false, publish: false } : item
  );
  assert.deepEqual((await b.search({ user: 'bia', audiences: denied })).body.facts, []);
  assert.equal((await b.search({ user: 'bia', audiences })).body.facts.length, 1);
});

test('organization routing isolates shared facts and private proposals in one server', async (t) => {
  const b = await setup(t);
  const proposal = (await b.draft()).body.proposal;
  await b.share(proposal);
  assert.deepEqual((await b.search({ organization: 'org-b' })).body.facts, []);
  assert.deepEqual((await b.call('/proposals', { organization: 'org-b' })).body.proposals, []);
  assert.equal((await b.share(proposal, { organization: 'org-b' })).status, 404);
});

test('legacy facts stay quarantined for the same organization including owner management and history', async (t) => {
  const b = await setup(t);
  const old = b.fact(b.areas.frota, 'A revisão da frota era feita em segredo.');
  assert.deepEqual((await b.search({ user: 'owner', organization: 'jr' })).body.facts, []);
  assert.deepEqual((await b.call('/manage/facts', { user: 'owner', organization: 'jr' })).body.facts, []);
  assert.equal((await b.call(`/manage/facts/${old}/history`, { user: 'owner', organization: 'jr' })).status, 404);
});

test('relinking ERP identity does not expose or publish a prior private draft', async (t) => {
  const b = await setup(t);
  const proposal = (await b.draft()).body.proposal;
  const changed = { erpUserId: 'erp_new' };
  assert.deepEqual((await b.call('/proposals', changed)).body.proposals, []);
  assert.equal((await b.revise(proposal, { text: SOURCE }, changed)).status, 404);
  assert.equal((await b.share(proposal, changed)).status, 404);
});

test('official procedure remains absent until an ERP-authorized reviewer approves it', async (t) => {
  const b = await setup(t);
  let proposal = (await b.draft()).body.proposal;
  proposal = (await b.revise(proposal, { kind: 'official_procedure' })).body.proposal;
  assert.equal((await b.share(proposal)).body.proposal.status, 'pending_review');
  assert.deepEqual((await b.search()).body.facts, []);
  assert.equal((await b.call('/manage/proposals')).status, 403);
  const reviewPath = `/manage/proposals/${proposal.id}/review`;
  assert.equal(
    (
      await b.call(reviewPath, {
        method: 'POST',
        user: 'owner',
        body: { version: proposal.version, decision: 'approve' },
      })
    ).status,
    403
  );
  const result = await b.call(reviewPath, {
    method: 'POST',
    user: 'revisor',
    rights: { approveOfficial: true },
    body: { version: proposal.version, decision: 'approve' },
  });
  assert.equal(result.body.proposal.status, 'active');
  assert.equal((await b.search()).body.facts.length, 1);
});

test('ERP rejection never publishes an official procedure', async (t) => {
  const b = await setup(t);
  let proposal = (await b.draft()).body.proposal;
  proposal = (await b.revise(proposal, { kind: 'official_procedure' })).body.proposal;
  await b.share(proposal);
  const result = await b.call(`/manage/proposals/${proposal.id}/review`, {
    method: 'POST',
    user: 'revisor',
    rights: { approveOfficial: true },
    body: { version: proposal.version, decision: 'reject' },
  });
  assert.equal(result.body.proposal.status, 'rejected');
  assert.deepEqual((await b.search()).body.facts, []);
});

test('ordinary authors revise their note using ERP alteration rights without official-approval rights', async (t) => {
  const b = await setup(t);
  const original = (await b.draft()).body.proposal;
  const fact = (await b.share(original)).body.fact;
  const created = await b.draft({ rights: { publish: false }, body: { factId: fact.id } });
  assert.equal(created.status, 201);
  assert.equal((await b.share(created.body.proposal, { rights: { publish: false } })).status, 200);
  assert.equal((await b.draft({ user: 'bia', body: { factId: fact.id } })).status, 404);
  const visible = (await b.search()).body.facts;
  assert.equal(visible.length, 1);
  assert.equal(visible[0].version, 2);
});

test('the live Brain refuses local ACL administration and legacy peer discovery', async (t) => {
  const b = await setup(t);
  for (const path of ['/manage/areas', '/manage/diagnostics', '/manage/log', '/peers'])
    assert.equal((await b.call(path, { user: 'owner' })).status, 403);
  assert.equal(
    (await b.call('/manage/members/ana', { user: 'owner', method: 'PUT', body: { memberships: [] } })).status,
    403
  );
});

test('live management flags and suspension enforce ERP author-only mutation', async (t) => {
  const b = await setup(t);
  const proposal = (await b.draft()).body.proposal;
  const fact = (await b.share(proposal)).body.fact;
  const other = (await b.call('/manage/facts', { user: 'bia' })).body.facts[0];
  assert.equal(other.canRevise, false);
  assert.equal(other.canWithdraw, false);
  assert.equal(
    (await b.call(`/manage/facts/${fact.id}`, { method: 'PATCH', user: 'bia', body: { active: false } })).status,
    403
  );
  assert.equal((await b.call(`/manage/facts/${fact.id}`, { method: 'PATCH', body: { active: false } })).status, 200);
  assert.deepEqual((await b.search()).body.facts, []);
});

test('revising a module-protected source cannot broaden its audience to the whole company', async (t) => {
  const b = await setup(t);
  const audiences = [
    { key: 'empresa', label: 'Empresa ERP', read: true, publish: true, review: false },
    { key: 'modulo:frota', label: 'Frota ERP', read: true, publish: true, review: false },
  ];
  const created = (await b.draft({ audiences })).body;
  const company = created.audiences.find((item) => item.key === 'empresa').id;
  const fleet = created.audiences.find((item) => item.key === 'modulo:frota').id;
  const source = (await b.revise(created.proposal, { areaId: fleet }, { audiences })).body.proposal;
  const fact = (await b.share(source, { audiences })).body.fact;
  const revision = (await b.draft({ audiences, body: { factId: fact.id } })).body.proposal;
  const result = await b.revise(revision, { areaId: company }, { audiences });
  assert.deepEqual([result.status, result.body.error.code], [403, 'source_audience_locked']);
});

test('mapped labels alone never make facts without ERP provenance and consent searchable', async (t) => {
  const b = await setup(t);
  const proposal = (await b.draft()).body.proposal;
  const fact = (await b.share(proposal)).body.fact;
  const tenant = createBrainStore(join(b.directory, 'brain.sqlite'), { companyId: 'org-a' });
  const legacy = tenant.facts.insert({
    areaId: fact.areaId,
    risk: 'low',
    kind: 'fato',
    text: 'revisão frota conteúdo sem consentimento',
    authorUserId: 'ana',
    sourceKind: 'usuario_afirmou',
    confidence: 9,
  });
  tenant.close();
  assert.deepEqual(
    (await b.search()).body.facts.map((item) => item.id),
    [fact.id]
  );
  assert.deepEqual(
    (await b.call('/manage/facts')).body.facts.map((item) => item.id),
    [fact.id]
  );
  assert.equal((await b.call(`/manage/facts/${legacy}/history`)).status, 404);
});

test('overlapping curator calls keep their organization context across awaits', async (t) => {
  let release;
  let entered;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let first = true;
  const b = await setup(t, {
    curator: {
      async propose() {
        if (first) {
          first = false;
          entered();
          await wait;
        }
        return { text: SOURCE, sourceQuote: SOURCE, sourceKind: 'usuario_afirmou', risk: 'low', areaId: 9999 };
      },
      drain: async () => {},
    },
  });
  const a = b.draft({ organization: 'org-a' });
  await started;
  const other = (await b.draft({ organization: 'org-b' })).body.proposal;
  await b.share(other, { organization: 'org-b' });
  release();
  const own = (await a).body.proposal;
  const published = (await b.share(own, { organization: 'org-a' })).body.fact;
  assert.deepEqual(
    (await b.search({ organization: 'org-a' })).body.facts.map((item) => item.id),
    [published.id]
  );
  assert.equal((await b.call('/proposals', { organization: 'org-b' })).body.proposals[0].id, other.id);
});
