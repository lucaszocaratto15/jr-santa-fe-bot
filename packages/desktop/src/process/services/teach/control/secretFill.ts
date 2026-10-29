/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CdpBridgeHandle } from '@process/resources/builtinMcp/cdpBridge';
import { originAllowed } from '../vault/originMatch';

export type FillResult = { ok: true } | { ok: false; error: string };
export type FillOptions = {
  requirePassword: boolean;
  allowedOrigins?: string[];
  /** Press Enter after filling, so the agent never needs page JS while the secret is in a field (R13). */
  submit?: boolean;
};
export type FillDeps = {
  bridge: Pick<CdpBridgeHandle, 'sendCommand' | 'addSecret' | 'isClientsLocked'>;
  currentUrl(): string;
  webContentsId(): number;
};

export const FILL_ERRORS = {
  origin: 'domínio não autorizado para este item do cofre',
  focus: 'clique no campo antes de preencher',
  password: 'o campo focado não é de senha',
  browser: 'navegador do app não está pronto',
  locked: 'navegador bloqueado: gravação ou funcionário no controle',
} as const;

const ENTER_KEY = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 } as const;

const NON_TEXT_INPUT_TYPES = [
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'file',
  'image',
  'hidden',
  'range',
  'color',
];

/**
 * Describes `document.activeElement` as `{ editable, isPassword }` only. It deliberately never
 * reads the element's value, so nothing typed in the page comes back over CDP.
 */
export const FOCUS_CHECK_EXPRESSION = `(() => {
  const el = document.activeElement;
  if (!el) return { editable: false, isPassword: false };
  const disabled = el.disabled === true || el.readOnly === true;
  if (el.tagName === 'INPUT') {
    const type = String(el.type || 'text').toLowerCase();
    return { editable: !disabled && !${JSON.stringify(NON_TEXT_INPUT_TYPES)}.includes(type), isPassword: type === 'password' };
  }
  if (el.tagName === 'TEXTAREA') return { editable: !disabled, isPassword: false };
  return { editable: el.isContentEditable === true, isPassword: false };
})()`;

type Focus = { editable: boolean; isPassword: boolean };

const readFocus = (response: unknown): Focus => {
  const value = (response as { result?: { value?: unknown } } | null)?.result?.value;
  if (typeof value !== 'object' || value === null) return { editable: false, isPassword: false };
  const { editable, isPassword } = value as Record<string, unknown>;
  return { editable: editable === true, isPassword: isPassword === true };
};

/**
 * Types `value` into the focused field of the attached in-app browser page. The value is
 * registered for redaction before it is inserted and is never part of the result. With
 * `submit`, Enter is pressed from main afterwards.
 */
export async function fillFocused(deps: FillDeps, value: string, opts: FillOptions): Promise<FillResult> {
  // R15: never type while a recording or an employee take-over holds the browser.
  if (deps.bridge.isClientsLocked()) return { ok: false, error: FILL_ERRORS.locked };
  const originOk = () => !opts.allowedOrigins || originAllowed(deps.currentUrl(), opts.allowedOrigins);
  if (!originOk()) return { ok: false, error: FILL_ERRORS.origin };
  try {
    const focus = readFocus(
      await deps.bridge.sendCommand('Runtime.evaluate', { expression: FOCUS_CHECK_EXPRESSION, returnByValue: true })
    );
    if (!focus.editable) return { ok: false, error: FILL_ERRORS.focus };
    if (opts.requirePassword && !focus.isPassword) return { ok: false, error: FILL_ERRORS.password };
    // The page may have navigated while we checked focus.
    if (!originOk()) return { ok: false, error: FILL_ERRORS.origin };
    // Register first so no event caused by the insert can reach clients unredacted.
    deps.bridge.addSecret(deps.webContentsId(), value);
    await deps.bridge.sendCommand('Input.insertText', { text: value });
    if (opts.submit) {
      await deps.bridge.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER_KEY, text: '\r' });
      await deps.bridge.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER_KEY });
    }
    return { ok: true };
  } catch {
    return { ok: false, error: FILL_ERRORS.browser };
  }
}
