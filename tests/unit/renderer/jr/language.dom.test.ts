import { expect, it, vi } from 'vitest';

const languageChanged = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
vi.mock('@/common/config/configService', () => ({
  configService: { whenReady: async () => {}, get: () => 'en-US', set: save },
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    systemSettings: { languageChanged: { on: languageChanged }, changeLanguage: { invoke: async () => {} } },
  },
}));

it('keeps JR in Portuguese despite saved, injected and requested English', async () => {
  localStorage.setItem('i18nextLng', 'en-US');
  window.__initialLanguage = 'en-US';
  const { default: i18n, changeLanguage } = await import('@/renderer/services/i18n');
  expect(i18n.language).toBe('pt-BR');
  await changeLanguage('en-US');
  expect(i18n.language).toBe('pt-BR');
  expect(save).toHaveBeenCalledWith('language', 'pt-BR');
  await languageChanged.mock.calls[0][0]({ language: 'en-US' });
  expect(i18n.language).toBe('pt-BR');
  expect(document.documentElement.lang).toBe('pt-BR');
});
