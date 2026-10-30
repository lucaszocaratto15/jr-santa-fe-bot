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

/**
 * Matched against name, id, label and placeholder. `código`/`code` count only as a separate
 * token (anything but a letter or digit around it, so `_` and `-` are boundaries): `codigo`,
 * `sms-code` and `codigo_produto` match (false positives only mask), `zipcode` does not.
 * `cpf` (Brazilian personal id) is masked and never photographed either.
 */
export const SECRET_TEXT_RE =
  /senha|password|passwd|pwd|otp|token|verifica[cç][aã]o|verification code|cvv|cvc|cart[aã]o|card number|pin\b|cpf|(?:^|[^a-z0-9])(?:c[oó]digo|code)(?:$|[^a-z0-9])/i;

const PASSWORD_AUTOCOMPLETE_RE = /^(?:current-password|new-password)$/i;

/**
 * True only for a real password field (type=password or a password autocomplete token), as
 * opposed to OTP or card fields. Only these earn a "save to the vault" offer.
 */
export function isPasswordField(a: FieldAttrs): boolean {
  if ((a.type ?? '').toLowerCase() === 'password') return true;
  return (a.autocomplete ?? '')
    .trim()
    .split(/\s+/)
    .some((token) => PASSWORD_AUTOCOMPLETE_RE.test(token));
}

/** True when the field must be masked as `«segredo»` and its value never recorded. */
export function isSecretField(a: FieldAttrs): boolean {
  if ((a.type ?? '').toLowerCase() === 'password') return true;
  const tokens = (a.autocomplete ?? '').trim().split(/\s+/);
  if (tokens.some((token) => SECRET_AUTOCOMPLETE_RE.test(token))) return true;
  return [a.name, a.id, a.label, a.placeholder].some((text) => !!text && SECRET_TEXT_RE.test(text));
}
