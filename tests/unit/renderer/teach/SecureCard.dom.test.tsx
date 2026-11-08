import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

const { invoke, listPending, requestListeners, expiredListeners } = vi.hoisted(() => ({
  invoke: vi.fn(async (_arg: unknown): Promise<{ saved?: boolean }> => ({})),
  listPending: vi.fn(async (): Promise<unknown[]> => []),
  requestListeners: [] as Array<(req: unknown) => void>,
  expiredListeners: [] as Array<(evt: { id: string }) => void>,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    teach: {
      showHandbook: { on: () => () => {} },
      secureRespond: { invoke },
      secureListPending: { invoke: listPending },
      secureRequest: { on: (fn: (req: unknown) => void) => requestListeners.push(fn) },
      secureExpired: { on: (fn: (evt: { id: string }) => void) => expiredListeners.push(fn) },
    },
  },
}));

import SecureCard from '@renderer/pages/conversation/Preview/browser/TeachCards/SecureCard';
import TeachCardHost from '@renderer/pages/conversation/Preview/browser/TeachCards/TeachCardHost';
import { resyncSecureRequests } from '@renderer/pages/conversation/Preview/browser/TeachCards/useSecureRequests';
import { Message } from '@arco-design/web-react';
import type { SecureRequest } from '@/common/adapter/ipcBridge';

const request = (over: Partial<SecureRequest> = {}): SecureRequest => ({
  id: 'r1',
  origin: 'https://portal.gov.br',
  kind: 'otp',
  label: 'Código enviado por SMS',
  allowSave: false,
  purpose: 'fill',
  ...over,
});

const passwordInput = () => document.querySelector('input') as HTMLInputElement;

describe('SecureCard', () => {
  beforeEach(() => {
    invoke.mockClear();
  });

  it('renders the origin, the request kind and the footnote', () => {
    render(<SecureCard request={request()} onDone={vi.fn()} />);
    expect(screen.getByText(/portal\.gov\.br/)).toBeTruthy();
    expect(screen.getByText(/common\.jr\.teach\.secure\.whatOtp/)).toBeTruthy();
    expect(screen.getByText('Código enviado por SMS')).toBeTruthy();
    expect(screen.getByText('common.jr.teach.secure.footnote')).toBeTruthy();
    expect(screen.queryByText('common.jr.teach.secure.saveToVault')).toBeNull();
    expect(passwordInput().type).toBe('password');
    expect(document.activeElement).toBe(passwordInput());
  });

  it('submits the value and clears the input', async () => {
    const onDone = vi.fn();
    render(<SecureCard request={request()} onDone={onDone} />);
    fireEvent.change(passwordInput(), { target: { value: '948372' } });
    fireEvent.click(screen.getByText('common.jr.teach.secure.send'));
    expect(passwordInput().value).toBe('');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith({ id: 'r1', value: '948372', save: false });
  });

  it('submits on Enter', async () => {
    render(<SecureCard request={request()} onDone={vi.fn()} />);
    fireEvent.change(passwordInput(), { target: { value: '111222' } });
    fireEvent.keyDown(passwordInput(), { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ id: 'r1', value: '111222', save: false }));
  });

  it('offers vault saving for passwords and sends the choice', async () => {
    render(<SecureCard request={request({ kind: 'password', allowSave: true })} onDone={vi.fn()} />);
    fireEvent.click(screen.getByText('common.jr.teach.secure.saveToVault'));
    fireEvent.change(passwordInput(), { target: { value: 'Senha-1' } });
    fireEvent.click(screen.getByText('common.jr.teach.secure.send'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ id: 'r1', value: 'Senha-1', save: true }));
  });

  it('cancels without a value', async () => {
    const onDone = vi.fn();
    render(<SecureCard request={request()} onDone={onDone} />);
    fireEvent.click(screen.getByText('common.jr.teach.secure.cancel'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith({ id: 'r1', cancelled: true });
  });

  it('shows the save-only variant without a fill checkbox', async () => {
    render(
      <SecureCard request={request({ kind: 'password', allowSave: true, purpose: 'save-only' })} onDone={vi.fn()} />
    );
    expect(screen.getByText(/common\.jr\.teach\.secure\.saveOnlyTitle/)).toBeTruthy();
    expect(screen.queryByText('common.jr.teach.secure.saveToVault')).toBeNull();
    fireEvent.change(passwordInput(), { target: { value: 'Senha-2' } });
    fireEvent.click(screen.getByText('common.jr.teach.secure.saveOnlySubmit'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ id: 'r1', value: 'Senha-2', save: true }));
  });
});

describe('SecureCard save results', () => {
  beforeEach(() => invoke.mockReset());

  it('uses the title as the dialog label', () => {
    render(<SecureCard request={request()} onDone={vi.fn()} />);
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toMatch(/common\.jr\.teach\.secure\.title/);
  });

  it('warns when the value was sent but the vault save failed', async () => {
    const warning = vi.spyOn(Message, 'warning').mockImplementation(() => () => undefined);
    invoke.mockResolvedValueOnce({ saved: false });
    const onDone = vi.fn();
    render(<SecureCard request={request({ kind: 'password', allowSave: true })} onDone={onDone} />);
    fireEvent.change(passwordInput(), { target: { value: 'Senha-1' } });
    fireEvent.click(screen.getByText('common.jr.teach.secure.send'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(warning).toHaveBeenCalledWith('common.jr.teach.secure.saveFailed');
    warning.mockRestore();
  });

  it('keeps a save-only card open for retry when saving fails', async () => {
    const warning = vi.spyOn(Message, 'warning').mockImplementation(() => () => undefined);
    invoke.mockResolvedValueOnce({ saved: false });
    const onDone = vi.fn();
    render(
      <SecureCard request={request({ kind: 'password', allowSave: true, purpose: 'save-only' })} onDone={onDone} />
    );
    fireEvent.change(passwordInput(), { target: { value: 'Senha-2' } });
    fireEvent.click(screen.getByText('common.jr.teach.secure.saveOnlySubmit'));
    await waitFor(() => expect(warning).toHaveBeenCalledWith('common.jr.teach.secure.saveOnlyFailed'));
    expect(onDone).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});

describe('TeachCardHost', () => {
  beforeEach(async () => {
    listPending.mockResolvedValue([]);
    await act(() => resyncSecureRequests());
  });

  it('pulls the pending list on mount, oldest first, then shows the next one after answering', async () => {
    listPending.mockResolvedValue([request({ id: 'a', label: 'primeiro' }), request({ id: 'b', label: 'segundo' })]);
    render(<TeachCardHost conversationId='c1' />);
    await waitFor(() => expect(screen.getByText('primeiro')).toBeTruthy());
    expect(screen.queryByText('segundo')).toBeNull();
    fireEvent.click(screen.getByText('common.jr.teach.secure.cancel'));
    await waitFor(() => expect(screen.getByText('segundo')).toBeTruthy());
  });

  it('keeps a request emitted before any host was mounted', async () => {
    listPending.mockRejectedValue(new Error('offline'));
    act(() => requestListeners.forEach((fn) => fn(request({ id: 'early', label: 'antes' }))));
    render(<TeachCardHost conversationId='c1' />);
    await waitFor(() => expect(screen.getByText('antes')).toBeTruthy());
  });

  it('drops the card when main reports it expired', async () => {
    render(<TeachCardHost conversationId='c1' />);
    act(() => requestListeners.forEach((fn) => fn(request({ id: 'x', label: 'expira' }))));
    expect(screen.getByText('expira')).toBeTruthy();
    act(() => expiredListeners.forEach((fn) => fn({ id: 'x' })));
    expect(screen.queryByText('expira')).toBeNull();
  });
});
