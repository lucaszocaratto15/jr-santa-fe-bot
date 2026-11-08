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
// "a senha do ERP é Ab12cd": a credential word, up to four words, then é/e/:/= and a password-like value.
const PASSWORD_PHRASE =
  /\b(?:senha|password|passwd|token|chave)\b(?:\s+[^\s:=]+){0,4}?(?:\s+(?:e|eh|is)\s+|\s*[:=]\s*)(\S{4,})/giu;

/** A value reads as a password when it has a digit, a symbol, or a capital after the first letter. */
function passwordLike(raw) {
  const value = raw.replace(/[.,;!?)]+$/u, '');
  if (value.length < 4) return false;
  return /\d/u.test(value) || /[^\p{L}\p{N}]/u.test(value) || (/\p{Ll}/u.test(value) && /\p{Lu}/u.test(value.slice(1)));
}

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
  if (PASSWORD.test(value) || [...value.matchAll(PASSWORD_PHRASE)].some((match) => passwordLike(match[1])))
    found.add('password');
  return [...found];
}

// Accents are stripped so "Sênha:" style variants still match; case is kept for token detection.
function normalizeForScan(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}

export const BRAIN_SERVICE_VERSION = 'brain-consent-v1';
const EVENTS = new Set([
  'capture_queued',
  'capture_sent',
  'curator_disabled',
  'curator_failed',
  'invalid_curator_response',
  'budget_exhausted',
  'batch_full',
  'proposal_created',
  'proposal_failed',
  'consent_granted',
  'consent_denied',
  'review_approved',
  'review_rejected',
  'note_activated',
  'search_executed',
  'search_empty',
  'search_failed',
  'authorization_failed',
]);

/** Operational events accept metadata only; callers cannot accidentally attach conversation text. */
export function diagnosticEvent(event, details = {}, now = Date.now) {
  if (!EVENTS.has(event)) throw new Error('invalid_diagnostic_event');
  const stage = event.startsWith('capture_')
    ? 'capture'
    : event.startsWith('search_')
      ? 'search'
      : event === 'authorization_failed'
        ? 'authorization'
        : event.startsWith('review_')
          ? 'review'
          : event.startsWith('consent_')
            ? 'consent'
            : event === 'note_activated'
              ? 'publication'
              : event.startsWith('proposal_')
                ? 'proposal'
                : 'curator';
  const result = {
    event,
    stage,
    state: event,
    timestamp: new Date(now()).toISOString(),
    serviceVersion: BRAIN_SERVICE_VERSION,
  };
  for (const key of ['correlationId', 'proposalId', 'noteId', 'searchId']) {
    if (
      typeof details[key] === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(details[key])
    )
      result[key] = details[key];
  }
  for (const key of ['durationMs', 'itemCount', 'version']) {
    if (Number.isFinite(details[key]) && details[key] >= 0) result[key] = Math.round(details[key]);
  }
  return result;
}
