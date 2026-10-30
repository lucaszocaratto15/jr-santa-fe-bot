import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { ptBR, readCommon, localeNames, withI18n } from '../teach/learn/i18nTestUtils';

const { consentState, accept } = vi.hoisted(() => ({ consentState: vi.fn(), accept: vi.fn() }));

vi.mock('@/common', () => ({
  ipcBridge: { brain: { consentState: { invoke: consentState }, accept: { invoke: accept } } },
}));
vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } };
});

import DataNoticeModal, { resetDataNoticeLaunch } from '@renderer/pages/Jr/JrSidebar/Brain/DataNoticeModal';

const i18n = ptBR();
const state = (current: boolean) => ({ acknowledgedVersion: current ? '1.4' : null, acknowledgedAt: null, current });
const mount = () => render(withI18n(i18n, <DataNoticeModal />));

describe('DataNoticeModal', () => {
  beforeEach(() => {
    resetDataNoticeLaunch();
    consentState.mockReset();
    accept.mockReset();
  });

  it('shows the notice when 1.4 was not acknowledged and the button acknowledges 1.4 once', async () => {
    consentState.mockResolvedValue(state(false));
    accept.mockResolvedValue(state(true));
    mount();
    const button = await screen.findByRole('button', { name: 'Li e entendi' });
    const text = screen.getByTestId('data-notice').textContent ?? '';
    expect(text).toContain('MiniMax');
    expect(text).toContain('48 horas');
    expect(text).not.toMatch(/limite|por dia|uma vez/i);
    expect(text).toContain('resultados de ferramentas');
    expect(text).toContain('Removemos os valores do seu Cofre');
    expect(text).not.toContain('dados pessoais não são guardados');
    fireEvent.click(button);
    await waitFor(() => expect(accept).toHaveBeenCalledWith({ termVersion: '1.4' }));
    await waitFor(() => expect(screen.queryByTestId('data-notice')).toBeNull());
  });

  it('stays hidden when 1.4 is already acknowledged', async () => {
    consentState.mockResolvedValue(state(true));
    mount();
    await waitFor(() => expect(consentState).toHaveBeenCalled());
    expect(screen.queryByTestId('data-notice')).toBeNull();
  });

  it('closing without the button hides it now and shows it again at the next launch', async () => {
    consentState.mockResolvedValue(state(false));
    const first = mount();
    await screen.findByTestId('data-notice');
    fireEvent.click(document.querySelector('.arco-modal-close-icon') as Element);
    await waitFor(() => expect(screen.queryByTestId('data-notice')).toBeNull());
    expect(accept).not.toHaveBeenCalled();
    // Same launch: a remount does not show it again.
    first.unmount();
    mount();
    await waitFor(() => expect(consentState).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('data-notice')).toBeNull();
    // Next launch.
    resetDataNoticeLaunch();
    mount();
    expect(await screen.findByTestId('data-notice')).toBeTruthy();
  });

  it('has the notice keys in every locale', () => {
    const keys = Object.keys((readCommon('pt-BR').jr as { dataNotice: object }).dataNotice).sort();
    for (const lang of localeNames()) {
      expect(Object.keys((readCommon(lang).jr as { dataNotice: object }).dataNotice).sort()).toEqual(keys);
    }
  });
});
