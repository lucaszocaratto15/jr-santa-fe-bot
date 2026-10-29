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
 * ponytail: exact + simple transforms only; a determined in-page encoding (e.g. charCode math) can still leak — upgrade path: block Runtime.evaluate from clients while a secret is live.
 */
export const redactSecrets = (text: string, secrets: readonly string[]): string => {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;

    // Joined by a single separator between characters (longest form first).
    const chars = Array.from(secret).map((c) => escapeRegex(jsonInner(c)));
    out = out.replace(new RegExp(chars.join(SEPARATOR), 'g'), REDACTED);

    const b64 = Buffer.from(secret).toString('base64');
    const variants = new Set([
      jsonInner(secret),
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

/** True for a main-frame navigation (no parentId), after which page-held secrets are gone. */
export const shouldClearSecretsOn = (method: string, params: unknown): boolean => {
  if (method !== 'Page.frameNavigated') return false;
  const frame = (params as { frame?: { parentId?: unknown } } | undefined)?.frame;
  return !!frame && frame.parentId === undefined;
};

/** True for recorder-internal binding calls that must not reach bridge clients. */
export const isInternalBindingEvent = (method: string, params: unknown): boolean => {
  if (method !== 'Runtime.bindingCalled') return false;
  const name = (params as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && name.startsWith(INTERNAL_BINDING_PREFIX);
};
