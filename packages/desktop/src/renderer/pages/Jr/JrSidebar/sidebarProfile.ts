import type { JrAccessUser } from '@/common/config/clientSettings';

/** Owner display name when the control row still stores the role word. */
export const OWNER_PROFILE_NAME = 'Lucas Zocaratto';

const ROLE_PLACEHOLDERS = new Set([
  'admin',
  'administrator',
  'administrador',
  'employee',
  'funcionario',
  'funcionário',
]);

export type SidebarProfile = {
  name: string;
  initial: string;
  role: 'admin' | 'employee' | null;
};

/** Up to two initials from the person's name. */
export function initialsFromName(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0] ?? '')
    .join('')
    .toLocaleUpperCase('pt-BR');
  return letters || '?';
}

const isRolePlaceholder = (name: string): boolean => ROLE_PLACEHOLDERS.has(name.trim().toLocaleLowerCase('pt-BR'));

/**
 * Name shown in the sidebar footer.
 * Employees keep the name stored on the invite. The owner keeps a real stored
 * name, and a role-word placeholder (the seeded "Administrador") is replaced
 * so the footer does not show the role as the person's name.
 */
export function sidebarProfile(user: Pick<JrAccessUser, 'id' | 'name' | 'role'> | null | undefined): SidebarProfile {
  const role = user?.role === 'employee' ? 'employee' : user?.role === 'admin' || user?.id === 'owner' ? 'admin' : null;
  const raw = user?.name?.trim() ?? '';
  const name = raw && !(isRolePlaceholder(raw) && role === 'admin') ? raw : role === 'admin' ? OWNER_PROFILE_NAME : raw;
  return { name, initial: initialsFromName(name), role };
}
