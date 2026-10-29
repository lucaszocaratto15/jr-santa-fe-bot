/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers that keep live vault secrets out of CDP traffic relayed to bridge clients.
 */

export const REDACTED = '«segredo»';
const MIN_SECRET_LENGTH = 4;

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
 * Ceiling: base64 bodies at arbitrary byte offsets (e.g. Network.getResponseBody) are NOT matched.
 *
 * Exact + simple transforms only; this is defence in depth. The real barrier (R13) lives in
 * cdpBridge: while a live secret sits in an input/textarea of the page, client
 * Runtime.evaluate / callFunctionOn / compileScript / Debugger.evaluateOnCallFrame are refused
 * (a value-free boolean probe decides), and vault_fill / secure_input submit the form via
 * `submit: true` so the agent never needs page JS while the secret is in a field.
 * Remaining ceiling: page listeners installed BEFORE the fill (e.g. by a pre-planned prompt
 * injection) can copy an encoded form of the value elsewhere in the page and read it after
 * the field is cleared or submitted.
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
