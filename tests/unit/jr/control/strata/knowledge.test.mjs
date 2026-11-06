import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { knowledgePolicy } from '../../../../../services/control/strata/knowledge.mjs';
import { createBrainServer } from '../../../../../services/brain/server.mjs';
import { createStrataBrainAuthorization } from '../../../../../services/brain/access.mjs';
import { fixture } from './fixture.mjs';
import { startBrain } from '../../brain/support.mjs';
import { createBrainStore } from '../../../../../services/brain/store.mjs';

const SECRET = 'knowledge-integration-fixture-not-a-real-secret';
const principal = { erpUserId: 'erp-a', organizationId: 'org-a' };
const policy = () => ({
  policy_version: 1,
  user_id: 'erp-a',
  organization_id: 'org-a',
  capabilities: { read: true, publish: true, revise: true, withdraw: true, approveOfficial: false },
  audiences: [{ key: 'empresa', label: 'Fixture company', read: true, publish: true, review: false }],
});
const claims = (init) => JSON.parse(Buffer.from(init.headers['x-brain-erp-context'].split('.')[0], 'base64url'));
const authorizedReply = (init, body) =>
  Response.json(body, {
    headers: {
      'x-brain-authorization': claims(init).v === 3 ? 'erp-v3' : 'erp-v2',
      'x-brain-organization': claims(init).organizationId,
      ...(claims(init).knowledgePolicy?.group ? { 'x-brain-group': claims(init).knowledgePolicy.group.id } : {}),
    },
  });
const brainCall = (f, path = '/me', body) =>
  f.app.request(`/api/brain${path}`, {
    token: f.owner.token,
    ...(body === undefined ? {} : { method: 'POST', body }),
  });

const group = () => ({
  id: 'group-jr',
  name: 'Grupo JR',
  organizations: [
    { id: 'org-a', name: 'Empresa A' },
    { id: 'org-b', name: 'Empresa B' },
  ],
});

test('JR searches the shared Brain group without a selection and keeps source notes unchanged', async (t) => {
  const brain = await startBrain(t, {
    secret: SECRET,
    erpAuthorization: true,
    resolveAuthorization: createStrataBrainAuthorization(SECRET),
  });
  const sourceStore = createBrainStore(join(brain.directory, 'brain.sqlite'), { companyId: 'org-b' });
  t.after(() => sourceStore.close());
  const [area] = sourceStore.areas.syncErpAudiences([{ key: 'modulo:engenharia', label: 'Engineering' }]);
  const id = sourceStore.facts.insert({
    areaId: area.id,
    text: 'Obra conhecimento compartilhado',
    sourceQuote: 'Trecho aprovado',
    risk: 'low',
    sourceKind: 'usuario_afirmou',
    authorUserId: 'employee-b',
    authorErpUserId: 'erp-b',
    confidence: 9,
    noteId: randomUUID(),
    consentHash: 'explicit-fixture-consent',
  });
  const before = sourceStore.facts.get(id);
  const f = await fixture(t, { brainUrl: brain.baseUrl, brainSecret: SECRET });
  await f.link(f.owner, { select: false });
  f.erp.state.knowledgeGroup = group();
  const result = await (await brainCall(f, '/search', { query: 'Obra' })).json();
  assert.deepEqual(
    [result.searchScope.companyCount, result.facts[0].id, result.facts[0].organizationId],
    [2, id, 'org-b']
  );
  assert.deepEqual(sourceStore.facts.get(id), before);
  assert.equal((await brainCall(f, '/feedback', { factId: id })).status, 200);
  f.erp.state.permissions = false;
  assert.equal((await brainCall(f, '/search', { query: 'Obra' })).status, 403);
});

test('group policy requires explicit ERP membership and rejects an external company or malformed scope', () => {
  const current = { ...principal, memberships: group().organizations.map((item) => ({ organization_id: item.id })) };
  assert.deepEqual(knowledgePolicy({ ...policy(), group: group() }, current).group, group());
  for (const invalid of [
    null,
    { ...group(), organizations: [] },
    { ...group(), organizations: [...group().organizations, { id: 'foreign', name: 'Outside' }] },
    { ...group(), organizations: [group().organizations[1]] },
    { ...group(), organizations: [group().organizations[0], group().organizations[0]] },
  ]) {
    assert.throws(() => knowledgePolicy({ ...policy(), group: invalid }, current), {
      code: 'strata_knowledge_policy_required',
    });
  }
});

test('group search needs no company selection and resolves one ERP policy before and after the result', async (t) => {
  const forwarded = [];
  const f = await fixture(t, {
    brainUrl: 'http://brain.invalid',
    brainSecret: SECRET,
    brainFetch: async (_url, init) => {
      forwarded.push(claims(init));
      return authorizedReply(init, { facts: [] });
    },
  });
  await f.link(f.owner, { select: false });
  f.erp.state.knowledgeGroup = group();
  assert.equal((await brainCall(f, '/search', { query: 'group' })).status, 200);
  assert.deepEqual([forwarded[0].v, forwarded[0].knowledgePolicy.group, f.erp.state.knowledgeCalls], [3, group(), 2]);
  assert.equal((await (await f.app.request('/strata/status', { token: f.owner.token })).json()).organizationId, null);
});

test('group change during a search discards the result before returning it', async (t) => {
  const f = await fixture(t, {
    brainUrl: 'http://brain.invalid',
    brainSecret: SECRET,
    brainFetch: async (_url, init) => {
      f.erp.state.knowledgeGroup = { ...group(), organizations: [group().organizations[0]] };
      return authorizedReply(init, { facts: [{ text: 'must-not-leak-from-removed-company' }] });
    },
  });
  await f.link();
  f.erp.state.knowledgeGroup = group();
  const response = await brainCall(f, '/search', { query: 'group' });
  assert.equal(response.status, 403);
  assert.equal((await response.text()).includes('must-not-leak'), false);
});

test('a Brain that does not acknowledge the group protocol cannot release a partial search', async (t) => {
  let read = false;
  const f = await fixture(t, {
    brainUrl: 'http://brain.invalid',
    brainSecret: SECRET,
    brainFetch: async (_url, init) => {
      const reply = Response.json(
        { facts: [{ text: 'old-result' }] },
        {
          headers: {
            'x-brain-authorization': 'erp-v2',
            'x-brain-organization': claims(init).organizationId,
          },
        }
      );
      reply.text = async () => {
        read = true;
        return '{}';
      };
      return reply;
    },
  });
  await f.link();
  f.erp.state.knowledgeGroup = group();
  assert.equal((await brainCall(f, '/search', { query: 'group' })).status, 503);
  assert.equal(read, false);
});

test('policy validation copies only ERP identity, audiences and explicit boolean capabilities', () => {
  const raw = { ...policy(), token: 'fixture-secret', localRole: 'owner' };
  raw.audiences[0].userAreas = ['invented-grant'];
  assert.deepEqual(knowledgePolicy(raw, principal), policy());
});

test('malformed, excessive, cross-user and cross-organization policies fail closed', () => {
  const invalid = [
    null,
    { ...policy(), policy_version: 2 },
    { ...policy(), user_id: 'erp-b' },
    { ...policy(), organization_id: 'org-b' },
    { ...policy(), capabilities: { ...policy().capabilities, read: 'true' } },
    {
      ...policy(),
      audiences: Array.from({ length: 101 }, (_, id) => ({ ...policy().audiences[0], key: `modulo:m${id}` })),
    },
    { ...policy(), audiences: [policy().audiences[0], policy().audiences[0]] },
    { ...policy(), audiences: [{ ...policy().audiences[0], key: 'jr-area:financeiro' }] },
    { ...policy(), audiences: [{ ...policy().audiences[0], label: 'x'.repeat(101) }] },
    { ...policy(), audiences: [{ ...policy().audiences[0], label: 'unsafe\nlabel' }] },
    { ...policy(), audiences: [{ ...policy().audiences[0], review: true }] },
    { ...policy(), capabilities: { ...policy().capabilities, read: false } },
  ];
  for (const input of invalid)
    assert.throws(() => knowledgePolicy(input, principal), { code: 'strata_knowledge_policy_required' });
});

test('a linked JR administrator transports current ERP rights without gaining approval from JR role', async (t) => {
  const forwarded = [];
  const f = await fixture(t, {
    brainUrl: 'http://brain.invalid',
    brainSecret: SECRET,
    brainFetch: async (_url, init) => {
      forwarded.push(init);
      return authorizedReply(init, { ok: true });
    },
  });
  await f.link();
  f.erp.state.knowledgePolicyOverride = policy();
  assert.equal((await brainCall(f)).status, 200);
  const context = claims(forwarded[0]);
  assert.equal(context.v, 2);
  assert.deepEqual(context.knowledgePolicy, policy());
  assert.equal(f.owner.user.role, 'admin');
  assert.equal(context.knowledgePolicy.capabilities.approveOfficial, false);
  assert.equal(f.erp.state.knowledgeCalls, 2);
  assert.equal('authorization' in forwarded[0].headers, false);
});

test('ERP denial or malformed policy prevents any restricted brain request', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    brainUrl: 'http://brain.invalid',
    brainSecret: SECRET,
    brainFetch: async (_url, init) => {
      calls += 1;
      return authorizedReply(init, { secret: 'must-not-be-fetched' });
    },
  });
  await f.link();
  for (const override of [{}, { ...policy(), organization_id: 'org-b' }, { ...policy(), user_id: 'erp-b' }]) {
    f.erp.state.knowledgePolicyOverride = override;
    // The mutable provider fixture must finish one denial before accepting the next policy.
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await brainCall(f)).status, 403);
  }
  f.erp.state.knowledgePolicyOverride = null;
  f.erp.state.knowledgeDenied = true;
  assert.equal((await brainCall(f)).status, 403);
  assert.equal(calls, 0);
});

test('provider credentials reflected in ERP policy labels are removed before signing the brain context', async (t) => {
  const forwarded = [];
  const f = await fixture(t, {
    brainUrl: 'http://brain.invalid',
    brainSecret: SECRET,
    brainFetch: async (_url, init) => {
      forwarded.push(init);
      return authorizedReply(init, { ok: true });
    },
  });
  await f.link();
  const raw = policy();
  raw.audiences[0].label = f.erp.tokens[0];
  f.erp.state.knowledgePolicyOverride = raw;
  assert.equal((await brainCall(f)).status, 200);
  const value = claims(forwarded[0]);
  assert.equal(value.knowledgePolicy.audiences[0].label, '[redacted]');
  assert.equal(
    f.erp.tokens.some((token) => JSON.stringify(value).includes(token)),
    false
  );
});

test('an unavailable ERP cannot return a cached brain response', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    brainUrl: 'http://brain.invalid',
    brainSecret: SECRET,
    brainFetch: async (_url, init) => {
      calls += 1;
      return authorizedReply(init, { ok: true });
    },
  });
  await f.link();
  assert.equal((await brainCall(f)).status, 200);
  f.erp.state.unavailable = true;
  assert.equal((await brainCall(f)).status, 503);
  assert.equal(calls, 1);
});

test('an old brain success without explicit ERP authorization acknowledgement cannot release content', async (t) => {
  let reads = 0;
  const f = await fixture(t, {
    brainUrl: 'http://brain.invalid',
    brainSecret: SECRET,
    brainFetch: async () => {
      const reply = Response.json({ facts: [{ text: 'legacy-brain-private-content' }] });
      const text = reply.text.bind(reply);
      reply.text = () => {
        reads += 1;
        return text();
      };
      return reply;
    },
  });
  await f.link();
  const response = await brainCall(f, '/search', { query: 'fixture' });
  assert.equal(response.status, 503);
  const result = await response.text();
  assert.equal(result.includes('brain_unavailable'), true);
  assert.equal(result.includes('legacy-brain-private-content'), false);
  assert.equal(reads, 0);
});

test('a successful brain reply acknowledging another organization cannot release content', async (t) => {
  const f = await fixture(t, {
    brainUrl: 'http://brain.invalid',
    brainSecret: SECRET,
    brainFetch: async () =>
      Response.json(
        { facts: [{ text: 'other-tenant-private-content' }] },
        {
          headers: { 'x-brain-authorization': 'erp-v2', 'x-brain-organization': 'org-b' },
        }
      ),
  });
  await f.link();
  const response = await brainCall(f, '/search', { query: 'fixture' });
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('other-tenant-private-content'), false);
});

async function pausedBrain(t) {
  let release;
  let entered;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const pending = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(t, {
    brainUrl: 'http://brain.invalid',
    brainSecret: SECRET,
    brainFetch: async (_url, init) => {
      entered();
      await wait;
      return authorizedReply(init, { facts: [{ text: 'old-organization-private-result' }] });
    },
  });
  await f.link();
  t.after(release);
  return { f, release, entered: pending };
}

test('switching ERP organization during brain processing discards the old result', async (t) => {
  const { f, release, entered } = await pausedBrain(t);
  const pending = brainCall(f, '/search', { query: 'fixture' });
  await entered;
  assert.equal(
    (
      await f.app.request('/strata/organization', {
        token: f.owner.token,
        method: 'POST',
        body: { organizationId: 'org-b' },
      })
    ).status,
    200
  );
  release();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.text()).includes('old-organization-private-result'), false);
});

test('revoking ERP knowledge rights while brain processes prevents old content from reaching the caller', async (t) => {
  const { f, release, entered } = await pausedBrain(t);
  const pending = brainCall(f, '/search', { query: 'fixture' });
  await entered;
  f.erp.state.permissions = false;
  release();
  const response = await pending;
  assert.equal(response.status, 403);
  assert.equal((await response.text()).includes('old-organization-private-result'), false);
  assert.equal((await f.app.request('/auth/session', { token: f.owner.token })).status, 200);
});

test('disconnecting during brain processing discards the old result', async (t) => {
  const { f, release, entered } = await pausedBrain(t);
  const pending = brainCall(f, '/search', { query: 'fixture' });
  await entered;
  assert.equal(
    (await f.app.request('/strata/disconnect', { token: f.owner.token, method: 'POST', body: {} })).status,
    200
  );
  release();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.text()).includes('old-organization-private-result'), false);
});

test('revoking the JR session during brain processing discards the old result', async (t) => {
  const { f, release, entered } = await pausedBrain(t);
  const pending = brainCall(f, '/search', { query: 'fixture' });
  await entered;
  assert.equal((await f.app.request('/auth/logout', { token: f.owner.token, method: 'POST', body: {} })).status, 200);
  release();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes('old-organization-private-result'), false);
});

test('real OAuth fixture and ERP-policy brain publish and retrieve only consented tenant content', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jr-brain-erp-integration-'));
  const source = 'Fixture fleet review happens on Friday.';
  const brain = createBrainServer({
    databasePath: join(dir, 'brain.sqlite'),
    secret: SECRET,
    erpAuthorization: true,
    resolveAuthorization: createStrataBrainAuthorization(SECRET),
    curator: {
      propose: async () => ({
        text: source,
        sourceQuote: source,
        sourceKind: 'usuario_afirmou',
        risk: 'low',
        areaId: 1,
      }),
      drain: async () => {},
    },
  });
  brain.server.listen(0, '127.0.0.1');
  await once(brain.server, 'listening');
  t.after(async () => {
    await brain.close();
    await rm(dir, { recursive: true, force: true });
  });
  const f = await fixture(t, { brainUrl: `http://127.0.0.1:${brain.server.address().port}`, brainSecret: SECRET });
  await f.link();
  const created = await brainCall(f, '/proposals', {
    authorized: true,
    requestId: randomUUID(),
    messages: [{ role: 'user', text: source }],
  });
  assert.equal(created.status, 201, await created.clone().text());
  const draft = (await created.json()).proposal;
  const shared = await brainCall(f, `/proposals/${draft.id}/consent`, {
    version: draft.version,
    hash: draft.hash,
    decision: 'share',
  });
  assert.equal(shared.status, 200, await shared.clone().text());
  const permitted = await brainCall(f, '/search', { query: 'fleet' });
  assert.equal(permitted.status, 200, await permitted.clone().text());
  assert.equal(
    (await permitted.json()).facts.some((fact) => fact.text === source),
    true
  );
  f.erp.state.permissions = false;
  const denied = await brainCall(f, '/search', { query: 'fleet' });
  assert.equal(denied.status, 403);
  assert.equal((await denied.text()).includes(source), false);
  f.erp.state.permissions = true;
  await f.app.request('/strata/organization', {
    token: f.owner.token,
    method: 'POST',
    body: { organizationId: 'org-b' },
  });
  const otherTenant = await brainCall(f, '/search', { query: 'fleet' });
  assert.equal(otherTenant.status, 200);
  assert.deepEqual((await otherTenant.json()).facts, []);
});
