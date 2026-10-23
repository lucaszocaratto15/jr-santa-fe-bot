import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const show = (role: 'admin' | 'employee', id = 'staff-1') =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <JrAccessContext.Provider
        value={{
          state: { status: 'authenticated', user: { id, name: 'Gestor', role } } satisfies JrAccessState,
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
it('creates an employee from Novo funcionário and lists the invite with copy, revoke and block', async () => {
  let created = false;
  mocks.list.mockImplementation(async () =>
    created
      ? [
          {
            id: 'person',
            name: 'Equipe teste',
            email: 'ana@empresa.com',
            role: 'employee',
            revoked: false,
            blocked: false,
          },
        ]
      : []
  );
  mocks.invite.mockImplementation(async () => {
    created = true;
    return { id: 'person', code: 'test-code-not-a-real-credential', expiresAt: '2026-10-29T15:00:00Z' };
  });
  show('admin', 'owner');
  expect(screen.queryByLabelText('common.jr.access.employeeName')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.newEmployee' }));
  fireEvent.change(await screen.findByLabelText('common.jr.access.employeeName'), {
    target: { value: 'Equipe teste' },
  });
  fireEvent.change(screen.getByLabelText('common.jr.access.employeeEmail'), { target: { value: 'ana@empresa.com' } });
  expect(screen.queryByLabelText('common.jr.access.tokenLimit')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('common.jr.access.startTime')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('common.jr.access.endTime')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.createEmployee' }));
  expect(await screen.findByText('test-code-not-a-real-credential')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.jr.access.copyCode' })).toBeInTheDocument();
  expect(await screen.findByText('ana@empresa.com')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.jr.access.revokeAction' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.jr.access.blockAction' })).toBeInTheDocument();
  expect(mocks.invite).toHaveBeenCalledWith({
    name: 'Equipe teste',
    email: 'ana@empresa.com',
    tokenLimit: null,
    accessStart: null,
    accessEnd: null,
  });
});
it('creates an invite without an email, token limit, or access window', async () => {
  mocks.invite.mockResolvedValue({ id: 'person', code: 'policy-code', expiresAt: '2026-10-29T15:00:00Z' });
  show('admin', 'owner');
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.newEmployee' }));
  fireEvent.change(await screen.findByLabelText('common.jr.access.employeeName'), { target: { value: 'Turno' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.createEmployee' }));
  expect(await screen.findByText('policy-code')).toBeInTheDocument();
  expect(mocks.invite).toHaveBeenCalledWith({
    name: 'Turno',
    email: null,
    tokenLimit: null,
    accessStart: null,
    accessEnd: null,
  });
});
it('keeps a malformed email in the form and does not create an employee', async () => {
  show('admin', 'owner');
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.newEmployee' }));
  fireEvent.change(await screen.findByLabelText('common.jr.access.employeeName'), { target: { value: 'Turno' } });
  fireEvent.change(screen.getByLabelText('common.jr.access.employeeEmail'), { target: { value: 'not-an-email' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.createEmployee' }));
  expect(await screen.findByText('common.jr.access.invalidEmail')).toBeInTheDocument();
  expect(mocks.invite).not.toHaveBeenCalled();
});
it('treats the owner account as an administrator when the role label is not admin', async () => {
  show('employee', 'owner');
  expect(await screen.findByRole('button', { name: 'common.jr.access.newEmployee' })).toBeInTheDocument();
  expect(mocks.list).toHaveBeenCalled();
});
it('closes the revoke dialog from the X, cancel, and the backdrop', async () => {
  mocks.list.mockResolvedValue([{ id: 'person-1', name: 'Ana', role: 'employee', revoked: false, blocked: false }]);
  show('admin', 'owner');
  const open = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'common.jr.access.revokeAction' }));
    expect(await screen.findByRole('dialog', { name: 'common.jr.access.revokeTitle' })).toBeInTheDocument();
  };
  const closed = () =>
    waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'common.jr.access.revokeTitle' })).not.toBeInTheDocument()
    );
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await closed();
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
  await closed();
  await open();
  const backdrop = document.querySelector('.arco-modal-wrapper');
  if (!backdrop) throw new Error('revoke dialog backdrop missing');
  fireEvent.mouseDown(backdrop);
  fireEvent.click(backdrop);
  await closed();
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
  show('admin', 'owner');
  expect(await screen.findByText('Ana')).toBeInTheDocument();
  expect(screen.queryByLabelText('common.jr.access.tokenLimit')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'common.jr.access.savePolicy' })).not.toBeInTheDocument();
  expect(screen.getByText('common.jr.access.tokensUsed')).toBeInTheDocument();
  expect(mocks.updatePolicy).not.toHaveBeenCalled();
});
