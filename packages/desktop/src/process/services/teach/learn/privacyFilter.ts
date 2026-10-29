/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LearnExclusion, LearnExclusionKind, LearnSample } from '@/common/types/agent/learnTypes';

const rule = (id: string, kind: LearnExclusionKind, pattern: string): LearnExclusion => ({
  id,
  kind,
  pattern,
  builtin: true,
});

/** Spec §5.3: banks, WhatsApp and personal e-mail. Ids are stable so "Restaurar padrão" can match them. */
export const DEFAULT_EXCLUSIONS: readonly LearnExclusion[] = Object.freeze([
  // Banks: domains
  rule('bank-domain-itau', 'domain', 'itau.com.br'),
  rule('bank-domain-bradesco', 'domain', 'bradesco.com.br'),
  rule('bank-domain-santander', 'domain', 'santander.com.br'),
  rule('bank-domain-bb', 'domain', 'bb.com.br'),
  rule('bank-domain-caixa', 'domain', 'caixa.gov.br'),
  rule('bank-domain-nubank', 'domain', 'nubank.com.br'),
  rule('bank-domain-bancointer', 'domain', 'bancointer.com.br'),
  rule('bank-domain-inter', 'domain', 'inter.co'),
  rule('bank-domain-sicoob', 'domain', 'sicoob.com.br'),
  rule('bank-domain-sicredi', 'domain', 'sicredi.com.br'),
  rule('bank-domain-c6bank', 'domain', 'c6bank.com.br'),
  rule('bank-domain-btg', 'domain', 'btgpactual.com'),
  rule('bank-domain-mercadopago', 'domain', 'mercadopago.com.br'),
  rule('bank-domain-picpay', 'domain', 'picpay.com'),
  // Banks: titles
  rule('bank-title-itau', 'title', 'Itaú'),
  rule('bank-title-bradesco', 'title', 'Bradesco'),
  rule('bank-title-santander', 'title', 'Santander'),
  rule('bank-title-bb', 'title', 'Banco do Brasil'),
  rule('bank-title-caixa', 'title', 'Caixa Econômica'),
  rule('bank-title-nubank', 'title', 'Nubank'),
  rule('bank-title-inter', 'title', 'Banco Inter'),
  rule('bank-title-sicoob', 'title', 'Sicoob'),
  rule('bank-title-sicredi', 'title', 'Sicredi'),
  rule('bank-title-c6', 'title', 'C6 Bank'),
  rule('bank-title-internet-banking', 'title', 'Internet Banking'),
  // Banks: apps
  rule('bank-app-itau', 'app', 'Itaú'),
  rule('bank-app-nubank', 'app', 'Nubank'),
  // WhatsApp
  rule('whatsapp-app', 'app', 'WhatsApp'),
  rule('whatsapp-domain', 'domain', 'web.whatsapp.com'),
  rule('whatsapp-title', 'title', 'WhatsApp'),
  // Personal e-mail: domains
  rule('mail-domain-outlook-live', 'domain', 'outlook.live.com'),
  rule('mail-domain-yahoo', 'domain', 'mail.yahoo.com'),
  rule('mail-domain-uol', 'domain', 'mail.uol.com.br'),
  rule('mail-domain-bol', 'domain', 'email.bol.uol.com.br'),
  // Personal e-mail: account in the tab title
  rule('mail-title-gmail', 'title', '@gmail.com'),
  rule('mail-title-hotmail', 'title', '@hotmail.com'),
  rule('mail-title-outlook', 'title', '@outlook.com'),
  rule('mail-title-live', 'title', '@live.com'),
  rule('mail-title-yahoo', 'title', '@yahoo.com'),
  rule('mail-title-icloud', 'title', '@icloud.com'),
  rule('mail-title-uol', 'title', '@uol.com.br'),
  rule('mail-title-bol', 'title', '@bol.com.br'),
]);

/** Lowercase with accents stripped, for case- and accent-insensitive matching. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** A domain pattern may be typed with a scheme, `www.` or a path: keep only the host. */
function domainPattern(pattern: string): string {
  return normalizeForMatch(pattern.trim())
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#:].*$/, '')
    .replace(/^\.+|\.+$/g, '');
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host ? normalizeForMatch(host) : null;
  } catch {
    return null;
  }
}

/**
 * True when the sample matches any rule; the caller drops it with no trace.
 * `app`/`title` rules match by normalized substring. `domain` rules match the url host by dot
 * suffix, or, for a sample without a usable url, the normalized title by substring.
 */
export function isExcluded(
  sample: Pick<LearnSample, 'app' | 'title' | 'url'>,
  rules: readonly LearnExclusion[]
): boolean {
  const app = normalizeForMatch(sample.app);
  const title = sample.title ? normalizeForMatch(sample.title) : '';
  const host = hostOf(sample.url);
  return rules.some((exclusion) => {
    if (exclusion.kind === 'domain') {
      const domain = domainPattern(exclusion.pattern);
      if (!domain) return false;
      if (host) return host === domain || host.endsWith(`.${domain}`);
      return title.includes(domain);
    }
    const pattern = normalizeForMatch(exclusion.pattern.trim());
    if (!pattern) return false;
    return exclusion.kind === 'app' ? app.includes(pattern) : title.includes(pattern);
  });
}

/** Titles mentioning a secret keep only the app. `pin` needs a boundary so "shopping" survives. */
const SECRET_TITLE_RE = /senha|password|codigo|code|token|2fa|verificacao|cvv|cartao|\bpin(?![a-z])/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CNPJ_RE = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g;
const CPF_RE = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g;
const DIGITS_RE = /\d{4,}/g;
const MAX_TITLE = 120;

/** Clean a window title before it reaches a summary. null = keep only the app. */
export function redactTitle(title: string | null): string | null {
  if (title === null) return null;
  const trimmed = title.trim();
  if (!trimmed || SECRET_TITLE_RE.test(normalizeForMatch(trimmed))) return null;
  const cleaned = trimmed
    .replace(EMAIL_RE, '[email]')
    .replace(CNPJ_RE, '[doc]')
    .replace(CPF_RE, '[doc]')
    .replace(DIGITS_RE, '#')
    .slice(0, MAX_TITLE)
    .trim();
  return cleaned || null;
}
