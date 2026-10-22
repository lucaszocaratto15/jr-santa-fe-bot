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
it('sends a token limit with no access window', async () => {
  mocks.invite.mockResolvedValue({
    id: 'person',
    code: 'policy-code',
    expiresAt: '2026-10-29T15:00:00Z',
  });
  show('admin');
  fireEvent.change(await screen.findByLabelText('common.jr.access.employeeName'), { target: { value: 'Turno' } });
  fireEvent.change(screen.getByLabelText('common.jr.access.tokenLimit'), { target: { value: '1200' } });
  expect(screen.queryByLabelText('common.jr.access.startTime')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('common.jr.access.endTime')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.generateCode' }));
  expect(await screen.findByText('policy-code')).toBeInTheDocument();
  expect(mocks.invite).toHaveBeenCalledWith({
    name: 'Turno',
    tokenLimit: 1200,
    accessStart: null,
    accessEnd: null,
  });
});
it('saves a per-user token limit without an access window', async () => {
  mocks.list.mockResolvedValue([
    {
      id: 'person-1',
      name: 'Ana',
      role: 'employee',
      revoked: false,
      blocked: false,
      tokenLimit: null,
    },
  ]);
  mocks.updatePolicy.mockResolvedValue(undefined);
  show('admin');
  const limit = await screen.findByLabelText('common.jr.access.tokenLimit', { selector: '#jr-limit-person-1' });
  fireEvent.change(limit, { target: { value: '5000' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.savePolicy' }));
  await waitFor(() =>
    expect(mocks.updatePolicy).toHaveBeenCalledWith({
      employeeId: 'person-1',
      tokenLimit: 5000,
      accessStart: null,
      accessEnd: null,
    })
  );
});
