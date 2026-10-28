import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accessUser: { id: 'owner', name: 'Lucas Zocaratto', role: 'admin' as 'admin' | 'employee' },
  update: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@/renderer/pages/Jr/Access/context', () => ({
  useJrAccess: () => ({ state: { status: 'active', user: mocks.accessUser }, logout: vi.fn() }),
}));
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'dark', setTheme: vi.fn(), selectTheme: vi.fn(), activeId: 'dark' }),
}));
vi.mock('@/renderer/components/settings/checkForUpdatesShared', () => ({
  getIncludePrerelease: () => false,
  runUpdateCheck: (...args: unknown[]) => mocks.update(...args),
}));

import { ComputerPanel, GeneralPanel, UpdatesPanel } from '@/renderer/pages/Jr/JrSidebar/panels';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.accessUser = { id: 'owner', name: 'Lucas Zocaratto', role: 'admin' };
});

describe('JR settings panels', () => {
  it('shows the account initials with the role beside the company', () => {
    render(<GeneralPanel />);
    const account = screen.getByLabelText('common.jr.look.account');
    expect(account).toHaveTextContent('LZ');
    expect(account).toHaveTextContent('Lucas Zocaratto');
    expect(account).toHaveTextContent('common.jr.access.roleAdmin · common.jr.companyName');
    expect(screen.getByRole('button', { name: 'common.jr.access.signOut' })).toBeInTheDocument();
  });

  it('hides the computer name row when no name is available', () => {
    render(<ComputerPanel />);
    expect(screen.queryByText('common.jr.look.yourComputer')).not.toBeInTheDocument();
    expect(screen.getByText('common.jr.look.execution')).toBeInTheDocument();
    expect(screen.getByText('common.jr.look.botComputer')).toBeInTheDocument();
    expect(screen.getByText('common.jr.look.upToDateBanner')).toBeInTheDocument();
  });

  it('shows the installed version and the up-to-date line after a check', async () => {
    mocks.update.mockResolvedValue({ kind: 'upToDate', currentVersion: '2.2.5' });
    render(<UpdatesPanel />);
    expect(await screen.findByText('update.upToDateTitle')).toBeInTheDocument();
    expect(screen.getByText('common.jr.look.versionLabel:{"version":"2.2.5"}')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.jr.look.checkUpdates' })).toBeEnabled();
  });
});
