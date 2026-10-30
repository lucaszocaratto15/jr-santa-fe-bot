/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers that keep live vault secrets out of CDP traffic relayed to bridge clients.
 */

export const REDACTED = '«segredo»';
/** Shorter secrets are neither redacted nor probed (too many false matches). */
export const MIN_SECRET_LENGTH = 4;

/** Name prefix of the internal Runtime bindings the teach recorder installs (never relayed to clients). */
export const INTERNAL_BINDING_PREFIX = '__jrTeach';

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The text a string takes inside a JSON string literal. */
const jsonInner = (s: string): string => JSON.stringify(s).slice(1, -1);

// One separator: a single non-alphanumeric char, or a JSON escape sequence (e.g. \n,  ).
const SEPARATOR = '(?:\\\\u[0-9a-fA-F]{4}|\\\\.|[^A-Za-z0-9])';

/**
 * Replace every live secret (and simple transforms of it) with a placeholder.
 * Operates on serialized (JSON) text, so secrets are matched in their JSON-escaped form.
 *
 * Exact + simple transforms only; this is defence in depth, not the barrier.
 *
 * What protects a live secret (R13 + R16):
 *  - Every client-bound CDP frame is redacted here (string values and keys only, R14).
 *  - Request bodies are stripped while a secret is live (stripPostData).
 *  - cdpBridge refuses client Runtime.evaluate / callFunctionOn / compileScript /
 *    Debugger.evaluateOnCallFrame while a PROBED secret (password, OTP, secure_input value)
 *    sits in an input/textarea. A value-free boolean probe decides: it receives the secrets
 *    as Runtime.callFunctionOn arguments, so no secret is ever part of a script source
 *    (Debugger.searchInContent / getScriptSource cannot find it). The probe fails closed:
 *    error, non-false answer or no answer within 2 s all refuse the command.
 *  - vault_fill / secure_input submit the form via `submit: true`, so the agent never needs
 *    page JS while the secret is in a field.
 *
 * Not covered (known ceiling):
 *  - Usernames (vault `field: 'username'`) are redaction-only: the agent may run page JS
 *    while one sits in a field and read it in a transformed form this function cannot match.
 *  - Secrets shorter than MIN_SECRET_LENGTH are neither redacted nor probed.
 *  - DOM-mutation JS paths: page code (or agent JS run before the fill, or listeners
 *    installed earlier, e.g. by a pre-planned prompt injection) can copy the field value
 *    elsewhere (another element, attribute, storage, a closure) in an encoded form and read
 *    it once the field is cleared or the form submitted. The probe only inspects
 *    input/textarea values in the document, open shadow roots and same-origin frames;
 *    closed shadow roots, cross-origin frames and contenteditable are not inspected.
 *  - Screenshots / screencast frames are pixels and are not redacted (accepted per R11:
 *    OTP / text values in visible fields can appear; passwords render masked).
 *  - Non-string encodings (R14): numbers, arrays of char codes, typed arrays, base64 bodies
 *    at arbitrary byte offsets (e.g. Network.getResponseBody), hashes or custom ciphers.
 *
 * Upgrade path: run vault fills in an isolated world / dedicated webContents the agent
 * cannot script, or refuse all client page JS from fill until navigation (at the cost of
 * blocking the flows R16 keeps working), and redact screenshots of focused secret fields.
 */
export const redactSecrets = (text: string, secrets: readonly string[]): string => {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;

    // Joined by a single separator between characters (longest form first).
    const chars = Array.from(secret).map((c) => escapeRegex(jsonInner(c)));
    out = out.replace(new RegExp(chars.join(SEPARATOR), 'g'), REDACTED);

    const b64 = Buffer.from(secret).toString('base64');
    const enc = encodeURIComponent(secret);
    const variants = new Set([
      jsonInner(secret),
      jsonInner(jsonInner(secret)),
      enc,
      enc.replace(/%20/g, '+'),
      enc.replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+'),
      jsonInner(Array.from(secret).reverse().join('')),
      b64,
      b64.replace(/=+$/, ''),
    ]);
    for (const v of variants) {
      if (v.length >= MIN_SECRET_LENGTH) out = out.split(v).join(REDACTED);
    }
  }
  return out;
};

/** Redact one string value (matched in its JSON-escaped form, like the raw-text variant). */
const redactString = (value: string, secrets: readonly string[]): string => {
  const inner = jsonInner(value);
  const out = redactSecrets(inner, secrets);
  if (out === inner) return value;
  try {
    return JSON.parse(`"${out}"`) as string;
  } catch {
    // A match split an escape sequence: fail closed.
    return REDACTED;
  }
};

/**
 * Walk a parsed CDP message and redact only string values and object keys (R14). Numbers,
 * booleans and array structure are never touched, so a numeric secret (OTP) cannot corrupt
 * the JSON of a relayed frame.
 */
export const redactValue = (value: unknown, secrets: readonly string[]): unknown => {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[redactString(key, secrets)] = redactValue(item, secrets);
    }
    return out;
  }
  return value;
};

/**
 * Drop request bodies from Network events so a typed secret cannot leave via postData /
 * postDataEntries (the latter is base64 at arbitrary offsets, which redaction cannot match).
 */
export const stripPostData = (params: unknown): unknown => {
  if (!params || typeof params !== 'object') return params;
  const p = params as { request?: unknown };
  const req = p.request;
  if (!req || typeof req !== 'object') return params;
  const { postData: _a, postDataEntries: _b, ...rest } = req as Record<string, unknown>;
  return { ...p, request: rest };
};

/** True for recorder-internal binding calls that must not reach bridge clients. */
export const isInternalBindingEvent = (method: string, params: unknown): boolean => {
  if (method !== 'Runtime.bindingCalled') return false;
  const name = (params as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && name.startsWith(INTERNAL_BINDING_PREFIX);
};
