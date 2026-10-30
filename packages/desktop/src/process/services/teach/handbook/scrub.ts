/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Removes secrets and personal identifiers from handbook text before it is published. The patterns
 * mirror `services/brain/text.mjs` `findSecrets` (CPF, CNPJ, cards with Luhn, e-mail, token-like runs,
 * `senha:` / `password:`, "a senha do ERP é Ab12cd"); matches become `[removido]`. Pure.
 */

export const SCRUBBED = '[removido]';

const CPF = /(?<!\d)(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?!\d)/gu;
const CNPJ = /(?<!\d)(?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})(?!\d)/gu;
const CARD = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/gu;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/gu;
const KNOWN_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})/gu;
const LONG_RUN = /[A-Za-z0-9_+/=-]{32,}/gu;
const PASSWORD = /\b(?:senha|password|passwd|pwd|token|api[ _-]?key|secret|segredo)\s*[:=]\s*\S+/giu;
// "a senha do ERP é Ab12cd": a credential word, up to four words, then é/e/:/= and a password-like value.
const PASSWORD_PHRASE =
  /\b(?:senha|password|passwd|token|chave)\b(?:\s+[^\s:=]+){0,4}?(?:\s+(?:é|e|eh|is)\s+|\s*[:=]\s*)(\S{4,})/giu;

/** A value reads as a password when it has a digit, a symbol, or a capital after the first letter. */
function passwordLike(raw: string): boolean {
  const value = raw.replace(/[.,;!?)]+$/u, '');
  if (value.length < 4) return false;
  return /\d/u.test(value) || /[^\p{L}\p{N}]/u.test(value) || (/\p{Ll}/u.test(value) && /\p{Lu}/u.test(value.slice(1)));
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function scrubText(text: string): string {
  return text
    .replace(PASSWORD_PHRASE, (match: string, value: string) => (passwordLike(value) ? SCRUBBED : match))
    .replace(PASSWORD, SCRUBBED)
    .replace(EMAIL, SCRUBBED)
    .replace(KNOWN_TOKEN, SCRUBBED)
    .replace(LONG_RUN, (run) => (/[A-Za-z]/u.test(run) && /\d/u.test(run) ? SCRUBBED : run))
    .replace(CNPJ, SCRUBBED)
    .replace(CPF, SCRUBBED)
    .replace(CARD, (match) => {
      const digits = match.replace(/\D/gu, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? SCRUBBED : match;
    });
}
