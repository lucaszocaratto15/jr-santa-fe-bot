import React from 'react';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { JrAccessState } from '@/common/config/clientSettings';
const mocks = vi.hoisted(() => ({ status: vi.fn(), login: vi.fn(), logout: vi.fn(), listener: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/common', () => ({
  ipcBridge: {
    jr: {
      accessStatus: { invoke: mocks.status },
      login: { invoke: mocks.login },
      logout: { invoke: mocks.logout },
      accessChanged: { on: mocks.listener },
    },
  },
}));
import JrAccessGate from '@/renderer/pages/Jr/Access';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.listener.mockReturnValue(() => {});
  mocks.status.mockResolvedValue({ status: 'signed-out', user: null });
});
it('blocks company contents until a code is verified by the native service', async () => {
  render(
    <JrAccessGate>
      <div>private content</div>
    </JrAccessGate>
  );
  expect(await screen.findByLabelText('common.jr.access.code')).toBeInTheDocument();
  expect(screen.queryByText('private content')).not.toBeInTheDocument();
  mocks.login.mockResolvedValue({ status: 'authenticated', user: { id: 'person', name: 'Pessoa', role: 'employee' } });
  fireEvent.change(screen.getByLabelText('common.jr.access.code'), { target: { value: 'one-time-code' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.enter' }));
  expect(await screen.findByText('private content')).toBeInTheDocument();
  expect(mocks.login).toHaveBeenCalledWith({ code: 'one-time-code' });
  expect(localStorage.getItem('jr-token')).toBeNull();
});
it('hides active contents when the native service reports revocation', async () => {
  mocks.status.mockResolvedValue({ status: 'authenticated', user: { id: 'person', name: 'Pessoa', role: 'employee' } });
  render(
    <JrAccessGate>
      <div>private content</div>
    </JrAccessGate>
  );
  await screen.findByText('private content');
  await act(async () => {
    mocks.listener.mock.calls[0][0]({ status: 'revoked', user: null } satisfies JrAccessState);
  });
  expect(screen.queryByText('private content')).not.toBeInTheDocument();
  expect(await screen.findByText('common.jr.access.revoked')).toBeInTheDocument();
});
it('shows the code field and keeps enter disabled until a code is typed', async () => {
  render(
    <JrAccessGate>
      <div>private content</div>
    </JrAccessGate>
  );
  expect(await screen.findByPlaceholderText('common.jr.access.codePlaceholder')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.jr.access.enter' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('common.jr.access.code'), { target: { value: 'one-time-code' } });
  expect(screen.getByRole('button', { name: 'common.jr.access.enter' })).toBeEnabled();
});
it('shows the service error under the code field when the code is rejected', async () => {
  mocks.login.mockRejectedValue(new Error('nope'));
  render(
    <JrAccessGate>
      <div>private content</div>
    </JrAccessGate>
  );
  fireEvent.change(await screen.findByLabelText('common.jr.access.code'), { target: { value: 'bad-code' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.enter' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('common.jr.access.invalidCode');
  expect(screen.queryByText('private content')).not.toBeInTheDocument();
});
it('shows a blocked login on the access card without opening the workspace', async () => {
  mocks.login.mockRejectedValue(new Error('JR_ACCESS_BLOCKED'));
  render(
    <JrAccessGate>
      <div>private content</div>
    </JrAccessGate>
  );
  fireEvent.change(await screen.findByLabelText('common.jr.access.code'), { target: { value: 'bad-code' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.enter' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('common.jr.access.blocked');
  expect(screen.queryByText('private content')).not.toBeInTheDocument();
});
it('keeps the workspace closed when access is outside the allowed hours', async () => {
  mocks.status.mockResolvedValue({ status: 'authenticated', user: { id: 'person', name: 'Pessoa', role: 'employee' } });
  render(
    <JrAccessGate>
      <div>private content</div>
    </JrAccessGate>
  );
  await screen.findByText('private content');
  await act(async () => {
    mocks.listener.mock.calls[0][0]({ status: 'outside-hours', user: null } satisfies JrAccessState);
  });
  expect(screen.queryByText('private content')).not.toBeInTheDocument();
  expect(await screen.findByText('common.jr.access.outsideHours')).toBeInTheDocument();
});
it('keeps offline contents blocked and allows a new connection check', async () => {
  mocks.status.mockResolvedValue({ status: 'offline', user: null });
  render(
    <JrAccessGate>
      <div>private content</div>
    </JrAccessGate>
  );
  expect(await screen.findByText('common.jr.access.offline')).toBeInTheDocument();
  expect(screen.queryByText('private content')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.retry' }));
  await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
});
