/**
 * Pure classifier deciding whether a form field holds a secret (password, OTP, card data).
 * The regexes are the single source of truth: the in-page capture script embeds them
 * (see captureScript.ts) so page and main classify fields identically.
 */

export type FieldAttrs = {
  tag: string;
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  label?: string;
  placeholder?: string;
};

/** Matched against each whitespace-separated autocomplete token. */
export const SECRET_AUTOCOMPLETE_RE = /^(?:current-password|new-password|one-time-code|cc-[a-z-]+)$/i;

/** Matched against name, id, label and placeholder. */
export const SECRET_TEXT_RE =
  /senha|password|passwd|pwd|otp|token|c[oó]digo de verifica|verification code|cvv|cvc|cart[aã]o|card number|pin\b/i;

/** True when the field must be masked as `«segredo»` and its value never recorded. */
export function isSecretField(a: FieldAttrs): boolean {
  if ((a.type ?? '').toLowerCase() === 'password') return true;
  const tokens = (a.autocomplete ?? '').trim().split(/\s+/);
  if (tokens.some((token) => SECRET_AUTOCOMPLETE_RE.test(token))) return true;
  return [a.name, a.id, a.label, a.placeholder].some((text) => !!text && SECRET_TEXT_RE.test(text));
}
