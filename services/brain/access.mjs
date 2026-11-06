/**
 * Read scope for a user. Diretoria is only the user id `owner` and sees everything.
 * Otherwise `low` lists areas whose low-risk facts are readable (own areas + Geral) and
 * `high` lists the areas the user manages, whose high-risk facts are readable too.
 * `high` is never granted for Geral. The fallback area ("Sem área") is owner-only, so it is
 * never included for anyone else, even a stale member.
 */
export function readScope(identity, memberships, generalAreaId, fallbackAreaId = null) {
  if (identity.userId === 'owner') return { all: true };
  const low = new Set([generalAreaId]);
  const high = new Set();
  for (const membership of memberships) {
    if (membership.areaId === fallbackAreaId) continue;
    low.add(membership.areaId);
    if (membership.level === 'gestor' && membership.areaId !== generalAreaId) high.add(membership.areaId);
  }
  return { low, high };
}

/** Owner, or gestor of the area. */
export function canManage(identity, memberships, areaId) {
  if (identity.userId === 'owner') return true;
  return memberships.some((membership) => membership.areaId === areaId && membership.level === 'gestor');
}

/** Area x risk read rule for one fact (`areaId`, `risk`); status flags are not considered. */
export function canRead(scope, fact) {
  if (scope.all) return true;
  return fact.risk === 'high' ? scope.high.has(fact.areaId) : scope.low.has(fact.areaId);
}
import { createHmac, timingSafeEqual } from 'node:crypto';

const PRINCIPAL_ID = /^[A-Za-z0-9._:@-]{1,128}$/u;
const NONCE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const denied = () => Object.assign(new Error('authorization_failed'), { status: 403, code: 'authorization_failed' });

/** The ERP owns these rights; this boundary only checks the signed policy's shape and subject. */
export function validateKnowledgePolicy(value, erpUserId, organizationId) {
  const record = (item) => item !== null && typeof item === 'object' && !Array.isArray(item);
  const rights = ['read', 'publish', 'revise', 'withdraw', 'approveOfficial'];
  if (
    !record(value) ||
    value.policy_version !== 1 ||
    value.user_id !== erpUserId ||
    value.organization_id !== organizationId ||
    !record(value.capabilities) ||
    rights.some((key) => typeof value.capabilities[key] !== 'boolean') ||
    !Array.isArray(value.audiences) ||
    value.audiences.length > 100
  )
    throw denied();
  const seen = new Set();
  for (const audience of value.audiences) {
    if (
      !record(audience) ||
      typeof audience.key !== 'string' ||
      audience.key.length > 140 ||
      !/^(?:empresa|modulo:[A-Za-z0-9._:@-]{1,128})$/u.test(audience.key) ||
      seen.has(audience.key) ||
      typeof audience.label !== 'string' ||
      !audience.label.trim() ||
      audience.label.length > 100 ||
      [...audience.label].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      ['read', 'publish', 'review'].some((key) => typeof audience[key] !== 'boolean') ||
      (audience.read && !value.capabilities.read) ||
      (audience.publish && (!audience.read || !value.capabilities.publish)) ||
      (audience.review && (!audience.read || !value.capabilities.approveOfficial))
    )
      throw denied();
    seen.add(audience.key);
  }
  if (value.group !== undefined) {
    const group = value.group;
    const label = (item) =>
      typeof item === 'string' &&
      item.trim() &&
      item.length <= 200 &&
      [...item].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
    if (
      !record(group) ||
      typeof group.id !== 'string' ||
      !PRINCIPAL_ID.test(group.id) ||
      !label(group.name) ||
      !Array.isArray(group.organizations) ||
      !group.organizations.length ||
      group.organizations.length > 20
    )
      throw denied();
    const ids = new Set();
    for (const item of group.organizations) {
      if (
        !record(item) ||
        typeof item.id !== 'string' ||
        !PRINCIPAL_ID.test(item.id) ||
        !label(item.name) ||
        ids.has(item.id)
      )
        throw denied();
      ids.add(item.id);
    }
    if (!ids.has(organizationId)) throw denied();
  }
  return value;
}

/** Verify only the control service's short-lived request proof; possession grants no note permission. */
export function createBrainPrincipalVerifier(secret, now = Date.now) {
  const used = new Map();
  return (identity, request) => {
    const proof = request?.proof;
    if (typeof proof !== 'string' || proof.length > 49_152) throw denied();
    const [payload, signature, extra] = proof.split('.');
    if (
      !payload ||
      !signature ||
      extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/u.test(payload) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(signature)
    )
      throw denied();
    const expected = createHmac('sha256', secret).update(payload).digest();
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(expected, received)) throw denied();
    let value;
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw denied();
    }
    const instant = now();
    if (
      ![1, 2, 3].includes(value?.v) ||
      value.jrUserId !== identity.userId ||
      !PRINCIPAL_ID.test(value.erpUserId ?? '') ||
      !PRINCIPAL_ID.test(value.organizationId ?? '') ||
      value.method !== request.method ||
      value.path !== request.path ||
      !/^[a-f0-9]{64}$/u.test(value.bodyHash ?? '') ||
      value.bodyHash !== request.bodyHash ||
      !Number.isFinite(value.issuedAt) ||
      !Number.isFinite(value.expiresAt) ||
      value.issuedAt > instant + 5000 ||
      value.expiresAt <= instant ||
      value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.issuedAt > 30_000 ||
      !NONCE.test(value.nonce ?? '')
    )
      throw denied();
    const knowledgePolicy =
      value.v >= 2 ? validateKnowledgePolicy(value.knowledgePolicy, value.erpUserId, value.organizationId) : undefined;
    if ((value.v === 3) !== Boolean(knowledgePolicy?.group)) throw denied();
    for (const [nonce, expires] of used) if (expires <= instant) used.delete(nonce);
    if (used.has(value.nonce) || used.size >= 10_000) throw denied();
    used.set(value.nonce, value.expiresAt);
    return {
      jrUserId: value.jrUserId,
      erpUserId: value.erpUserId,
      organizationId: value.organizationId,
      ...(knowledgePolicy ? { knowledgePolicy } : {}),
    };
  };
}

/** Production authorization accepts only the current, ERP-owned knowledge policy. */
export function createStrataBrainAuthorization(secret, now = Date.now) {
  const verify = createBrainPrincipalVerifier(secret, now);
  return (identity, request) => {
    const principal = verify(identity, request);
    if (!principal.knowledgePolicy)
      throw Object.assign(new Error('erp_knowledge_policy_required'), {
        status: 403,
        code: 'erp_knowledge_policy_required',
      });
    return principal;
  };
}
