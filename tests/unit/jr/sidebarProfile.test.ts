import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { initialsFromName, OWNER_PROFILE_NAME, sidebarProfile } from '@/renderer/pages/Jr/JrSidebar/sidebarProfile';

describe('sidebar profile name', () => {
  it('uses the owner profile when the session still stores the role word', () => {
    expect(sidebarProfile({ id: 'owner', name: 'Administrador', role: 'admin' })).toEqual({
      name: OWNER_PROFILE_NAME,
      initial: 'LZ',
      role: 'admin',
    });
  });

  it('keeps an employee name even when it matches a role word', () => {
    expect(sidebarProfile({ id: 'emp-1', name: 'Administrador', role: 'employee' })).toEqual({
      name: 'Administrador',
      initial: 'A',
      role: 'employee',
    });
  });

  it('keeps a real administrator name and takes both initials', () => {
    expect(sidebarProfile({ id: 'owner', name: 'Maria Souza', role: 'admin' }).name).toBe('Maria Souza');
    expect(initialsFromName('Maria Souza')).toBe('MS');
  });

  it('returns no name when nobody is signed in', () => {
    expect(sidebarProfile(null)).toEqual({ name: '', initial: '?', role: null });
  });
});

describe('sidebar footer alignment', () => {
  const css = readFileSync('packages/desktop/src/renderer/pages/Jr/JrSidebar/JrSidebar.module.css', 'utf8');

  it('centers the profile row and the link button on one line', () => {
    expect(css).toMatch(/\.bottom\s*\{[^}]*align-items:\s*center/);
    expect(css).toMatch(/\.profile:global\(\.arco-btn\)\s*\{[^}]*align-items:\s*center/);
    expect(css).toMatch(/\.bottom \.iconButton:global\(\.arco-btn\)\s*\{[^}]*align-self:\s*center/);
  });
});
