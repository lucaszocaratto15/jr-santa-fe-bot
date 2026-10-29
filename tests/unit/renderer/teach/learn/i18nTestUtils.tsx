import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18next, { type i18n as I18n } from 'i18next';
import React from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';

export const LOCALES_DIR = join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');

export const readCommon = (lang: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(LOCALES_DIR, lang, 'common.json'), 'utf8')) as Record<string, unknown>;

export const localeNames = (): string[] =>
  readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

/** A real i18next instance with the pt-BR common module, as the app ships it. */
export function ptBR(): I18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: 'pt-BR',
    resources: { 'pt-BR': { translation: { common: readCommon('pt-BR') } } },
    interpolation: { escapeValue: false },
  });
  return instance;
}

export const withI18n = (instance: I18n, node: React.ReactNode) => (
  <I18nextProvider i18n={instance}>{node}</I18nextProvider>
);
