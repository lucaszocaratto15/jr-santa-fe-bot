import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import type { JrAccessState } from '@/common/config/clientSettings';
import { view } from './fixtures';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  setTitle: vi.fn(),
  adminRoles: vi.fn(),
  adminRole: vi.fn(),
  media: vi.fn(),
  personalUsage: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'pt-BR' },
  }),
}));
vi.mock('@renderer/components/Markdown/MermaidBlock', () => ({
  __esModule: true,
  default: ({ code }: { code: string }) => <pre data-testid='mermaid'>{code}</pre>,
}));
vi.mock('@/renderer/pages/Jr/Access/TeamUsage', () => ({ __esModule: true, default: () => null }));
vi.mock('@/common', () => ({
  ipcBridge: {
    jr: {
      personalUsage: { invoke: mocks.personalUsage },
      admin: { list: { invoke: mocks.list }, setTitle: { invoke: mocks.setTitle } },
      handbook: {
        adminRoles: { invoke: mocks.adminRoles },
        adminRole: { invoke: mocks.adminRole },
        media: { invoke: mocks.media },
      },
    },
  },
}));

import { JrAccessContext } from '@/renderer/pages/Jr/Access/context';
import JrAdmin from '@/renderer/pages/Jr/Access/Admin';

const person = { id: 'person-1', name: 'Ana', title: 'Auxiliar', role: 'employee', revoked: false, blocked: false };

const show = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <JrAccessContext.Provider
        value={{
          state: {
            status: 'authenticated',
            user: { id: 'owner', name: 'Gestor', role: 'admin' },
          } satisfies JrAccessState,
          logout: async () => {},
        }}
      >
        <JrAdmin />
      </JrAccessContext.Provider>
    </SWRConfig>
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([person]);
  mocks.personalUsage.mockResolvedValue({});
  mocks.adminRoles.mockResolvedValue([
    { key: 'auxiliar de escritorio', title: 'Auxiliar de escritório', activities: 1, updatedAt: 1 },
  ]);
  mocks.adminRole.mockResolvedValue(view);
  mocks.media.mockResolvedValue('data:image/jpeg;base64,AAAA');
});

describe('HandbookAdmin', () => {
  it('admin view lists roles and opens a role read-only (no edit or delete controls)', async () => {
    show();
    const section = await screen.findByTestId('handbook-admin');
    fireEvent.click(await within(section).findByText('Auxiliar de escritório'));
    await waitFor(() => expect(mocks.adminRole).toHaveBeenCalledWith({ key: 'auxiliar de escritorio' }));
    expect(await within(section).findByTestId('handbook-role')).toBeInTheDocument();
    expect(within(section).getByText('common.jr.handbook.admin.readOnly')).toBeInTheDocument();
    expect(within(section).queryByText(/withdraw|dismiss|approve|publish|review/i)).not.toBeInTheDocument();
    expect(section.textContent).not.toContain('Ana');
    expect(within(section).getByTestId('handbook-indicators').textContent).toContain('"count":2');
  });

  it('shows the empty text when no role has a handbook', async () => {
    mocks.adminRoles.mockResolvedValue([]);
    show();
    expect(await screen.findByText('common.jr.handbook.admin.empty')).toBeInTheDocument();
  });

  it('Editar cargo saves the new title and refreshes the employee row', async () => {
    let title = 'Auxiliar';
    mocks.list.mockImplementation(async () => [{ ...person, title }]);
    mocks.setTitle.mockImplementation(async (input: { title: string | null }) => {
      title = input.title ?? '';
      return { title: input.title };
    });
    show();
    fireEvent.click(await screen.findByText('common.jr.access.editTitle'));
    const input = await screen.findByLabelText('common.jr.access.employeeTitle');
    expect(input).toHaveValue('Auxiliar');
    fireEvent.change(input, { target: { value: '  Financeiro ' } });
    fireEvent.click(screen.getByText('common.save'));
    await waitFor(() => expect(mocks.setTitle).toHaveBeenCalledWith({ employeeId: 'person-1', title: 'Financeiro' }));
    expect(await screen.findByText('Financeiro')).toBeInTheDocument();
  });
});
