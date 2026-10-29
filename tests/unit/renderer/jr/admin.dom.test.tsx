import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import type { JrAccessState } from '@/common/config/clientSettings';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  invite: vi.fn(),
  reissue: vi.fn(),
  revoke: vi.fn(),
  updatePolicy: vi.fn(),
  setBlocked: vi.fn(),
  disconnectDevice: vi.fn(),
  accessStatus: vi.fn(),
  login: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }) }));
vi.mock('@/common', () => ({
  ipcBridge: {
    jr: {
      accessStatus: { invoke: mocks.accessStatus },
      accessChanged: { on: () => () => {} },
      login: { invoke: mocks.login },
      logout: { invoke: vi.fn() },
      admin: {
        disconnectDevice: { invoke: mocks.disconnectDevice },
        list: { invoke: mocks.list },
        createInvite: { invoke: mocks.invite },
        reissue: { invoke: mocks.reissue },
        revoke: { invoke: mocks.revoke },
        updatePolicy: { invoke: mocks.updatePolicy },
        setBlocked: { invoke: mocks.setBlocked },
      },
    },
  },
}));
import { JrAccessContext } from '@/renderer/pages/Jr/Access/context';
import JrAdmin from '@/renderer/pages/Jr/Access/Admin';
import JrAccessGate from '@/renderer/pages/Jr/Access';
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
  localStorage.clear();
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([]);
});
it('does not request administrative records for an employee', async () => {
  show('employee');
  expect(await screen.findByText('common.jr.access.adminOnly')).toBeInTheDocument();
  expect(mocks.list).not.toHaveBeenCalled();
});
it('creates an employee from Novo funcionário and shows a large code without an access date', async () => {
  let created = false;
  mocks.list.mockImplementation(async () =>
    created
      ? [
          {
            id: 'person',
            name: 'Equipe teste',
            title: 'Compras',
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
  fireEvent.change(screen.getByLabelText('common.jr.access.employeeTitle'), { target: { value: 'Compras' } });
  expect(screen.queryByLabelText('common.jr.access.employeeEmail')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('common.jr.access.tokenLimit')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('common.jr.access.startTime')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('common.jr.access.endTime')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.createEmployee' }));
  expect(await screen.findByText('test-code-not-a-real-credential')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.jr.access.copyCode' })).toBeInTheDocument();
  expect(screen.queryByText('common.jr.access.inviteHint')).not.toBeInTheDocument();
  expect(screen.queryByText('2026-10-29T15:00:00Z')).not.toBeInTheDocument();
  expect(await screen.findByText('Compras')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.jr.access.revokeAction' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.jr.access.blockAction' })).toBeInTheDocument();
  expect(mocks.invite).toHaveBeenCalledWith({
    name: 'Equipe teste',
    email: null,
    title: 'Compras',
    tokenLimit: null,
    accessStart: null,
    accessEnd: null,
  });
});
it('creates an invite without a job title, token limit, or access window', async () => {
  mocks.invite.mockResolvedValue({ id: 'person', code: 'policy-code', expiresAt: '2026-10-29T15:00:00Z' });
  show('admin', 'owner');
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.newEmployee' }));
  fireEvent.change(await screen.findByLabelText('common.jr.access.employeeName'), { target: { value: 'Turno' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.createEmployee' }));
  expect(await screen.findByText('policy-code')).toBeInTheDocument();
  expect(mocks.invite).toHaveBeenCalledWith({
    name: 'Turno',
    email: null,
    title: null,
    tokenLimit: null,
    accessStart: null,
    accessEnd: null,
  });
});
it('keeps the sheet open and does not list a new employee when creation fails', async () => {
  mocks.invite.mockRejectedValue(new Error('offline'));
  show('admin', 'owner');
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.newEmployee' }));
  fireEvent.change(await screen.findByLabelText('common.jr.access.employeeName'), { target: { value: 'Turno' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.createEmployee' }));
  expect(await screen.findByText('common.jr.access.actionError')).toBeInTheDocument();
  expect(screen.getByLabelText('common.jr.access.employeeName')).toBeInTheDocument();
  expect(screen.queryByText('Turno')).not.toBeInTheDocument();
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
  expect(await screen.findByRole('heading', { name: 'Ana' })).toBeInTheDocument();
  expect(screen.getByText('common.jr.access.activeStatus')).toBeInTheDocument();
  expect(screen.queryByLabelText('common.jr.access.tokenLimit')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'common.jr.access.savePolicy' })).not.toBeInTheDocument();
  expect(screen.queryByText('common.jr.access.tokensUsed')).not.toBeInTheDocument();
  expect(screen.queryByText('common.jr.access.personUsage')).not.toBeInTheDocument();
  expect(mocks.updatePolicy).not.toHaveBeenCalled();
});
it('reports a block failure and keeps the employee on the list', async () => {
  mocks.list.mockResolvedValue([{ id: 'person-1', name: 'Ana', role: 'employee', revoked: false, blocked: false }]);
  mocks.setBlocked.mockRejectedValue(new Error('offline'));
  show('admin', 'owner');
  fireEvent.click(await screen.findByRole('button', { name: 'common.jr.access.blockAction' }));
  expect(await screen.findByText('common.jr.access.actionError')).toBeInTheDocument();
  expect(mocks.setBlocked).toHaveBeenCalledWith({ employeeId: 'person-1', blocked: true });
  expect(screen.getByRole('heading', { name: 'Ana' })).toBeInTheDocument();
});

const base = { role: 'employee', revoked: false, blocked: false, maxDevices: 1, devices: [] };
it('lists auto-blocked employees in a banner and unblocks with setBlocked(false)', async () => {
  mocks.list.mockResolvedValue([
    { ...base, id: 'p1', name: 'Ana', blocked: true, blockedAt: '2026-10-29T15:30:00Z', blockedReason: 'auto_volume' },
    { ...base, id: 'p2', name: 'Beto', blocked: true, blockedAt: '2026-10-29T15:30:00Z', blockedReason: 'auto_hours' },
  ]);
  mocks.setBlocked.mockResolvedValue(undefined);
  show('admin', 'owner');
  const alerts = await screen.findAllByRole('alert');
  expect(alerts).toHaveLength(2);
  const unblock = within(alerts[0]).getByRole('button', { name: 'common.jr.access.unblockAction' });
  fireEvent.click(unblock);
  await waitFor(() => expect(mocks.setBlocked).toHaveBeenCalledWith({ employeeId: 'p1', blocked: false }));
});
it('dismisses an auto-block banner until a new auto block appears', async () => {
  const blocked = {
    ...base,
    id: 'p1',
    name: 'Ana',
    blocked: true,
    blockedAt: '2026-10-29T15:30:00Z',
    blockedReason: 'auto_volume',
  };
  mocks.list.mockResolvedValue([blocked]);
  const view = show('admin', 'owner');
  const alert = await screen.findByRole('alert');
  fireEvent.click(within(alert).getByRole('button', { name: 'common.jr.access.dismissAction' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  view.unmount();
  const again = show('admin', 'owner');
  expect(await screen.findByRole('heading', { name: 'Ana' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  again.unmount();
  mocks.list.mockResolvedValue([{ ...blocked, blockedAt: '2026-10-30T09:00:00Z' }]);
  show('admin', 'owner');
  expect(await screen.findByRole('alert')).toBeInTheDocument();
});
it('shows no banner for manual blocks', async () => {
  mocks.list.mockResolvedValue([
    { ...base, id: 'p1', name: 'Ana', blocked: true, blockedAt: '2026-10-29T15:30:00Z', blockedReason: null },
  ]);
  show('admin', 'owner');
  expect(await screen.findByRole('heading', { name: 'Ana' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('offers disconnect only for active devices and calls disconnectDevice after confirming', async () => {
  mocks.list.mockResolvedValue([
    {
      ...base,
      id: 'p1',
      name: 'Ana',
      devices: [
        {
          id: 'd1',
          name: 'PC-A',
          lastSeenAt: '2026-10-29T10:00:00Z',
          expiresAt: '2026-11-29T10:00:00Z',
          revokedAt: null,
        },
        {
          id: 'd2',
          name: 'PC-B',
          lastSeenAt: '2026-10-28T10:00:00Z',
          expiresAt: '2026-11-29T10:00:00Z',
          revokedAt: '2026-10-29T09:00:00Z',
        },
      ],
    },
  ]);
  mocks.disconnectDevice.mockResolvedValue(undefined);
  show('admin', 'owner');
  const buttons = await screen.findAllByRole('button', { name: 'common.jr.access.disconnectDevice' });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);
  fireEvent.click(await screen.findByRole('button', { name: 'common.confirm' }));
  await waitFor(() => expect(mocks.disconnectDevice).toHaveBeenCalledWith({ employeeId: 'p1', deviceId: 'd1' }));
});
it('saves the PC limit through updatePolicy keeping the other fields, and hides it for the owner', async () => {
  mocks.list.mockResolvedValue([
    {
      ...base,
      id: 'p1',
      name: 'Ana',
      tokenLimit: 9000,
      accessStart: '08:00',
      accessEnd: '18:00',
    },
    { ...base, id: 'owner', name: 'Dono', role: 'admin' },
  ]);
  mocks.updatePolicy.mockResolvedValue(undefined);
  show('admin', 'owner');
  const fields = await screen.findAllByLabelText('common.jr.access.maxDevicesLabel');
  expect(fields).toHaveLength(1);
  fireEvent.change(fields[0], { target: { value: '3' } });
  fireEvent.blur(fields[0]);
  await waitFor(() =>
    expect(mocks.updatePolicy).toHaveBeenCalledWith({
      employeeId: 'p1',
      tokenLimit: 9000,
      accessStart: '08:00',
      accessEnd: '18:00',
      maxDevices: 3,
    })
  );
});
it('shows the replaced message on the login screen', async () => {
  mocks.accessStatus.mockResolvedValue({ status: 'revoked', user: null, notice: 'replaced' });
  render(
    <JrAccessGate>
      <div />
    </JrAccessGate>
  );
  expect(await screen.findByText('common.jr.access.replaced')).toBeInTheDocument();
});
it('maps a handover failure to its own message', async () => {
  mocks.accessStatus.mockResolvedValue({ status: 'signed-out', user: null });
  mocks.login.mockRejectedValue(new Error('JR_ACCESS_HANDOVER_FAILED'));
  render(
    <JrAccessGate>
      <div />
    </JrAccessGate>
  );
  fireEvent.change(await screen.findByLabelText('common.jr.access.code'), { target: { value: 'abc' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.enter' }));
  expect(await screen.findByText('common.jr.access.handoverFailed')).toBeInTheDocument();
});
