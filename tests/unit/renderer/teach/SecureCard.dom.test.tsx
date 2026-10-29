import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(async (_arg: unknown) => undefined),
  listeners: [] as Array<(req: unknown) => void>,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    teach: {
      secureRespond: { invoke },
      secureRequest: {
        on: (fn: (req: unknown) => void) => {
          listeners.push(fn);
          return () => listeners.splice(listeners.indexOf(fn), 1);
        },
      },
    },
  },
}));

import SecureCard from '@renderer/pages/conversation/components/TeachCards/SecureCard';
import TeachCardHost from '@renderer/pages/conversation/components/TeachCards/TeachCardHost';
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

describe('TeachCardHost', () => {
  it('shows the oldest pending request first and the next one after answering', async () => {
    render(<TeachCardHost conversationId='c1' />);
    act(() => {
      listeners.forEach((fn) => fn(request({ id: 'a', label: 'primeiro' })));
      listeners.forEach((fn) => fn(request({ id: 'b', label: 'segundo' })));
    });
    expect(screen.getByText('primeiro')).toBeTruthy();
    expect(screen.queryByText('segundo')).toBeNull();
    fireEvent.click(screen.getByText('common.jr.teach.secure.cancel'));
    await waitFor(() => expect(screen.getByText('segundo')).toBeTruthy());
  });
});
