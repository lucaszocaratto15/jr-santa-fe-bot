/**
 * Pure URL sanitizer for teach recordings: masks the values of query and fragment
 * parameters whose names look secret (login GET forms, OAuth implicit-flow fragments)
 * and drops userinfo, so no credential in a URL reaches events.jsonl.
 */

import { REDACTED } from '@process/resources/builtinMcp/secretRedact';
import { SECRET_TEXT_RE } from './fieldClassifier';

/** Extra parameter names that are secret as a whole name segment (`api_key`, `access_token`, `pw`). */
const SECRET_PARAM_SEGMENT_RE = /^(?:token|access_token|code|otp|senha|password|pwd|pw|pass|pin|key|auth|secret)$/i;

/** `?name=value`, `&name=value` or `#name=value` (also inside a `#/route?x=y` fragment). */
const PARAM_RE = /([?&#])([^=&#?]+)=([^&#?]*)/g;

const decodeSafe = (text: string): string => {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
};

/** True when a URL parameter name should have its value masked. */
export function isSecretParamName(rawName: string): boolean {
  const name = decodeSafe(rawName).trim();
  if (SECRET_TEXT_RE.test(name)) return true;
  return name.split(/[_\-.[\]\s]+/).some((segment) => SECRET_PARAM_SEGMENT_RE.test(segment));
}

/**
 * Mask secret query/fragment parameter values with `«segredo»`. Non-web URLs keep only
 * their origin (`about:` URLs are kept); malformed input becomes ''.
 */
export function sanitizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.protocol === 'about:') return parsed.href;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return parsed.origin === 'null' ? '' : parsed.origin;
  }
  const tail = `${parsed.search}${parsed.hash}`.replace(PARAM_RE, (match, sep: string, name: string) =>
    isSecretParamName(name) ? `${sep}${name}=${REDACTED}` : match
  );
  return `${parsed.origin}${parsed.pathname}${tail}`;
}
