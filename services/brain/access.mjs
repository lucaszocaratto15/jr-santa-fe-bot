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
