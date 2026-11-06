import { httpError } from '../validation.mjs';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const CAPABILITIES = ['read', 'publish', 'revise', 'withdraw', 'approveOfficial'];

/** Copy only the explicit ERP authorization contract, never a JR role or a local area grant. */
export function knowledgePolicy(value, principal) {
  const invalid = () => {
    throw httpError(403, 'strata_knowledge_policy_required');
  };
  if (
    !record(value) ||
    value.policy_version !== 1 ||
    value.user_id !== principal.erpUserId ||
    value.organization_id !== principal.organizationId ||
    !record(value.capabilities) ||
    !Array.isArray(value.audiences) ||
    value.audiences.length > 100 ||
    CAPABILITIES.some((name) => typeof value.capabilities[name] !== 'boolean')
  )
    return invalid();
  const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, value.capabilities[name]]));
  if (!capabilities.read && CAPABILITIES.some((name) => name !== 'read' && capabilities[name])) return invalid();
  const seen = new Set();
  const audiences = value.audiences.map((audience) => {
    if (
      !record(audience) ||
      typeof audience.key !== 'string' ||
      audience.key.length > 140 ||
      !/^(?:empresa|modulo:[A-Za-z0-9._:-]{1,128})$/u.test(audience.key) ||
      seen.has(audience.key) ||
      typeof audience.label !== 'string' ||
      !audience.label.trim() ||
      audience.label.length > 100 ||
      [...audience.label].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      ['read', 'publish', 'review'].some((name) => typeof audience[name] !== 'boolean') ||
      (audience.read && !capabilities.read) ||
      (audience.publish && (!audience.read || !capabilities.publish)) ||
      (audience.review && (!audience.read || !capabilities.approveOfficial))
    )
      return invalid();
    seen.add(audience.key);
    return {
      key: audience.key,
      label: audience.label,
      read: audience.read,
      publish: audience.publish,
      review: audience.review,
    };
  });
  let group;
  if (value.group !== undefined) {
    const raw = value.group;
    const id = (item) => typeof item === 'string' && /^[A-Za-z0-9._:@-]{1,128}$/u.test(item);
    const label = (item) =>
      typeof item === 'string' &&
      item.trim() &&
      item.length <= 200 &&
      [...item].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
    if (
      !record(raw) ||
      !id(raw.id) ||
      !label(raw.name) ||
      !Array.isArray(raw.organizations) ||
      !raw.organizations.length ||
      raw.organizations.length > 20
    )
      return invalid();
    const ids = new Set();
    const organizations = raw.organizations.map((item) => {
      if (
        !record(item) ||
        !id(item.id) ||
        !label(item.name) ||
        ids.has(item.id) ||
        !principal.memberships?.some((member) => member.organization_id === item.id)
      )
        return invalid();
      ids.add(item.id);
      return { id: item.id, name: item.name };
    });
    if (!ids.has(principal.organizationId)) return invalid();
    group = { id: raw.id, name: raw.name, organizations };
  }
  return {
    policy_version: 1,
    user_id: value.user_id,
    organization_id: value.organization_id,
    audiences,
    capabilities,
    ...(group ? { group } : {}),
  };
}
