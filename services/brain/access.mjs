/**
 * Read scope for a user. Diretoria is only the user id `owner` and sees everything.
 * Otherwise `low` lists areas whose low-risk facts are readable (own areas + Geral) and
 * `high` lists the areas the user manages, whose high-risk facts are readable too.
 * `high` is never granted for Geral.
 */
export function readScope(identity, memberships, generalAreaId) {
  if (identity.userId === 'owner') return { all: true };
  const low = new Set([generalAreaId]);
  const high = new Set();
  for (const membership of memberships) {
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
