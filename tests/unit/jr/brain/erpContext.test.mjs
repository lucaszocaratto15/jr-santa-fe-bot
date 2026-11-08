import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { brainPrincipalProof } from '../../../../services/control/brain.mjs';
import { createBrainPrincipalVerifier, createStrataBrainAuthorization } from '../../../../services/brain/access.mjs';
import { startBrain, SECRET } from './support.mjs';

const identity = { id: 'owner', role: 'admin' };
const principal = { jrUserId: 'owner', erpUserId: 'erp-fixture-owner', organizationId: 'jr' };
const body = { query: 'fixture' };
const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
const request = (proof, extra = {}) => ({ proof, method: 'POST', path: '/search', bodyHash, ...extra });

test('internal identity proof is bound to caller, exact request and one use', () => {
  const verify = createBrainPrincipalVerifier(SECRET, () => 1000);
  const proof = brainPrincipalProof(SECRET, identity, principal, 'POST', '/search', body, () => 1000);
  assert.deepEqual(verify({ userId: 'owner' }, request(proof)), principal);
  assert.throws(() => verify({ userId: 'owner' }, request(proof)), { code: 'authorization_failed' });
});

test('proof rejects tampering, another user, another path, another body and expiry', () => {
  const proof = brainPrincipalProof(SECRET, identity, principal, 'POST', '/search', body, () => 1000);
  const attempts = [
    [{ userId: 'owner' }, request(`${proof.slice(0, -1)}!`)],
    [{ userId: 'another-user' }, request(proof)],
    [{ userId: 'owner' }, request(proof, { path: '/manage/proposals' })],
    [{ userId: 'owner' }, request(proof, { bodyHash: '0'.repeat(64) })],
  ];
  for (const [user, req] of attempts)
    assert.throws(() => createBrainPrincipalVerifier(SECRET, () => 1000)(user, req), { code: 'authorization_failed' });
  assert.throws(() => createBrainPrincipalVerifier(SECRET, () => 31_000)({ userId: 'owner' }, request(proof)), {
    code: 'authorization_failed',
  });
});

test('a real verified ERP identity does not invent JR-area or official-approval permissions', async (t) => {
  const b = await startBrain(t, {
    now: () => 1000,
    resolveAuthorization: createStrataBrainAuthorization(SECRET, () => 1000),
  });
  b.fact(b.areas.frota, 'Fixture private note');
  const proof = brainPrincipalProof(SECRET, identity, principal, 'POST', '/search', body, () => 1000);
  const result = await b.call('/search', { method: 'POST', body, headers: { 'x-brain-erp-context': proof } });
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'erp_knowledge_policy_required');
  assert.equal(JSON.stringify(result.body).includes('Fixture private note'), false);
});

test('unproved or spoofed ERP identity never unlocks restricted notes', async (t) => {
  const b = await startBrain(t, { resolveAuthorization: createStrataBrainAuthorization(SECRET) });
  const result = await b.call('/search', {
    method: 'POST',
    body,
    headers: { 'x-erp-user-id': 'erp-admin', 'x-brain-erp-context': 'spoofed.context' },
  });
  assert.deepEqual([result.status, result.body.error.code], [403, 'authorization_failed']);
});

test('v2 signed policy preserves explicit ERP rights without creating local area grants', () => {
  const knowledgePolicy = {
    policy_version: 1,
    user_id: principal.erpUserId,
    organization_id: principal.organizationId,
    capabilities: { read: true, publish: false, revise: false, withdraw: false, approveOfficial: false },
    audiences: [{ key: 'empresa', label: 'Empresa fixture', read: true, publish: false, review: false }],
  };
  const proof = brainPrincipalProof(
    SECRET,
    identity,
    { ...principal, knowledgePolicy },
    'POST',
    '/search',
    body,
    () => 1000
  );
  assert.deepEqual(createStrataBrainAuthorization(SECRET, () => 1000)({ userId: 'owner' }, request(proof)), {
    ...principal,
    knowledgePolicy,
  });
});

test('valid HMAC cannot authorize malformed, inconsistent or wrong-subject policy data', () => {
  const knowledgePolicy = {
    policy_version: 1,
    user_id: principal.erpUserId,
    organization_id: principal.organizationId,
    capabilities: { read: true, publish: true, revise: false, withdraw: false, approveOfficial: false },
    audiences: [{ key: 'empresa', label: 'Empresa fixture', read: true, publish: true, review: false }],
  };
  const invalid = [
    { ...knowledgePolicy, user_id: 'another-erp-user' },
    { ...knowledgePolicy, organization_id: 'another-company' },
    { ...knowledgePolicy, capabilities: { ...knowledgePolicy.capabilities, read: false } },
    { ...knowledgePolicy, audiences: [...knowledgePolicy.audiences, ...knowledgePolicy.audiences] },
    { ...knowledgePolicy, audiences: [{ ...knowledgePolicy.audiences[0], review: true }] },
    { ...knowledgePolicy, audiences: [{ ...knowledgePolicy.audiences[0], label: 'Empresa\nforjada' }] },
    {
      ...knowledgePolicy,
      audiences: Array.from({ length: 101 }, (_, index) => ({
        ...knowledgePolicy.audiences[0],
        key: `modulo:fixture-${index}`,
      })),
    },
  ];
  for (const policy of invalid) {
    const payload = Buffer.from(
      JSON.stringify({
        v: 2,
        ...principal,
        knowledgePolicy: policy,
        method: 'POST',
        path: '/search',
        bodyHash,
        issuedAt: 1000,
        expiresAt: 31_000,
        nonce: randomUUID(),
      })
    ).toString('base64url');
    const proof = `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
    assert.throws(() => createStrataBrainAuthorization(SECRET, () => 1000)({ userId: 'owner' }, request(proof)), {
      code: 'authorization_failed',
    });
  }
});
