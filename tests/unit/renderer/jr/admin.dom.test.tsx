import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import type { JrAccessState } from '@/common/config/clientSettings';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  invite: vi.fn(),
  reissue: vi.fn(),
  revoke: vi.fn(),
  updatePolicy: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }) }));
vi.mock('@/common', () => ({
  ipcBridge: {
    jr: {
      admin: {
        list: { invoke: mocks.list },
        createInvite: { invoke: mocks.invite },
        reissue: { invoke: mocks.reissue },
        revoke: { invoke: mocks.revoke },
        updatePolicy: { invoke: mocks.updatePolicy },
      },
    },
  },
}));
import { JrAccessContext } from '@/renderer/pages/Jr/Access/context';
import JrAdmin from '@/renderer/pages/Jr/Access/Admin';
const show = (role: 'admin' | 'employee') =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <JrAccessContext.Provider
        value={{
          state: { status: 'authenticated', user: { id: 'owner', name: 'Gestor', role } } satisfies JrAccessState,
          logout: async () => {},
        }}
      >
        <JrAdmin />
      </JrAccessContext.Provider>
    </SWRConfig>
  );
beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([]);
});
it('does not request administrative records for an employee', async () => {
  show('employee');
  expect(await screen.findByText('common.jr.access.adminOnly')).toBeInTheDocument();
  expect(mocks.list).not.toHaveBeenCalled();
});
it('creates a real one-time invitation and displays the returned code only after success', async () => {
  mocks.invite.mockResolvedValue({
    id: 'person',
    code: 'test-code-not-a-real-credential',
    expiresAt: '2026-10-29T15:00:00Z',
  });
  show('admin');
  await screen.findByLabelText('common.jr.access.employeeName');
  fireEvent.change(screen.getByLabelText('common.jr.access.employeeName'), { target: { value: 'Equipe teste' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.generateCode' }));
  expect(await screen.findByText('test-code-not-a-real-credential')).toBeInTheDocument();
  expect(mocks.invite).toHaveBeenCalledWith({
    name: 'Equipe teste',
    tokenLimit: null,
    accessStart: null,
    accessEnd: null,
  });
});
it('creates an invite without a token limit or access window', async () => {
  mocks.invite.mockResolvedValue({
    id: 'person',
    code: 'policy-code',
    expiresAt: '2026-10-29T15:00:00Z',
  });
  show('admin');
  fireEvent.change(await screen.findByLabelText('common.jr.access.employeeName'), { target: { value: 'Turno' } });
  expect(screen.queryByLabelText('common.jr.access.tokenLimit')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('common.jr.access.startTime')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('common.jr.access.endTime')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.generateCode' }));
  expect(await screen.findByText('policy-code')).toBeInTheDocument();
  expect(mocks.invite).toHaveBeenCalledWith({
    name: 'Turno',
    tokenLimit: null,
    accessStart: null,
    accessEnd: null,
  });
});
it('shows consumed usage and does not offer a token limit to save', async () => {
  mocks.list.mockResolvedValue([
    {
      id: 'person-1',
      name: 'Ana',
      role: 'employee',
      revoked: false,
      blocked: false,
      tokenLimit: 9000,
      usage: { totalTokens: 42, promptTokens: 30, completionTokens: 12, modelRequests: 2 },
    },
  ]);
  show('admin');
  expect(await screen.findByText('Ana')).toBeInTheDocument();
  expect(screen.queryByLabelText('common.jr.access.tokenLimit')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'common.jr.access.savePolicy' })).not.toBeInTheDocument();
  expect(screen.getByText('common.jr.access.tokensUsed')).toBeInTheDocument();
  expect(mocks.updatePolicy).not.toHaveBeenCalled();
});
