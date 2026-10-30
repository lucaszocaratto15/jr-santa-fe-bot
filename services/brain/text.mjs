/** Lowercase, strip accents and collapse whitespace; the form used for indexing and matching. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

const CPF = /(?<!\d)(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?!\d)/u;
const CNPJ = /(?<!\d)(?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})(?!\d)/u;
const CARD = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/gu;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const KNOWN_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})/u;
const LONG_RUN = /[A-Za-z0-9_+/=-]{32,}/gu;
const PASSWORD = /\b(?:senha|password|passwd|pwd|token|api[ _-]?key|secret|segredo)\s*[:=]\s*\S+/iu;

function luhn(digits) {
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

/** A long run is token-like when it mixes letters and digits (plain words and numbers are not secrets). */
function looksLikeToken(run) {
  return /[A-Za-z]/u.test(run) && /\d/u.test(run);
}

/** Names of the secret/PII kinds detected in text; the brain refuses to store text where any is found. */
export function findSecrets(text) {
  const value = normalizeForScan(text);
  const found = new Set();
  if (CPF.test(value)) found.add('cpf');
  if (CNPJ.test(value)) found.add('cnpj');
  for (const match of value.matchAll(CARD)) {
    const digits = match[0].replace(/\D/gu, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) found.add('card');
  }
  if (EMAIL.test(value)) found.add('email');
  if (KNOWN_TOKEN.test(value) || [...value.matchAll(LONG_RUN)].some((match) => looksLikeToken(match[0])))
    found.add('token');
  if (PASSWORD.test(value)) found.add('password');
  return [...found];
}

// Accents are stripped so "Sênha:" style variants still match; case is kept for token detection.
function normalizeForScan(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}
