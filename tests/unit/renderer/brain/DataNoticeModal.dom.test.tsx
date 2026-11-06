import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { BRAIN_TERM_VERSION } from '@/common/types/agent/brainTypes';
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
const state = (current: boolean) => ({
  acknowledgedVersion: current ? BRAIN_TERM_VERSION : null,
  acknowledgedAt: null,
  current,
});
const mount = () => render(withI18n(i18n, <DataNoticeModal />));

describe('DataNoticeModal', () => {
  beforeEach(() => {
    resetDataNoticeLaunch();
    consentState.mockReset();
    accept.mockReset();
  });

  it('shows the notice when the current notice was not acknowledged and records that version once', async () => {
    consentState.mockResolvedValue(state(false));
    accept.mockResolvedValue(state(true));
    mount();
    const button = await screen.findByRole('button', { name: 'Li e entendi' });
    const text = screen.getByTestId('data-notice').textContent ?? '';
    expect(text).toContain('48 horas');
    expect(text).toContain('autoriza');
    expect(text).toContain('trecho');
    expect(text).not.toContain('dados pessoais não são guardados');
    fireEvent.click(button);
    await waitFor(() => expect(accept).toHaveBeenCalledWith({ termVersion: BRAIN_TERM_VERSION }));
    await waitFor(() => expect(screen.queryByTestId('data-notice')).toBeNull());
  });

  it('stays hidden when the current notice is acknowledged', async () => {
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
    const keys = Object.keys((readCommon('pt-BR').jr as { dataNotice: object }).dataNotice).toSorted();
    for (const lang of localeNames()) {
      expect(Object.keys((readCommon(lang).jr as { dataNotice: object }).dataNotice).toSorted()).toEqual(keys);
    }
  });

  it('describes retention without promising that authorized source text is never stored', () => {
    for (const lang of ['pt-BR', 'en-US']) {
      const body = (readCommon(lang).jr as { dataNotice: { retentionBody: string } }).dataNotice.retentionBody;
      expect(body).toContain('48');
      expect(body).toContain('90');
      expect(body).not.toMatch(/nunca ficam guardados|never stored/u);
    }
  });
});
