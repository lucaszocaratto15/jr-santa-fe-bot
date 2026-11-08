/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

const ALLOWED_WEBVIEW_PROTOCOLS = new Set([
  'http:',
  'https:',
  'file:',
  'data:',
  'blob:',
  'chrome-extension:',
  'about:',
]);

export type WebviewPreferencesLike = {
  preload?: string;
  nodeIntegration?: boolean;
  contextIsolation?: boolean;
  webSecurity?: boolean;
};

/**
 * Strips privileged webview preferences and rejects non-web schemes before a
 * <webview> is attached. Returns false when the caller must preventDefault().
 */
export function sanitizeWebviewPreferences(preferences: WebviewPreferencesLike, params: { src?: string }): boolean {
  delete preferences.preload;
  preferences.nodeIntegration = false;
  preferences.contextIsolation = true;
  preferences.webSecurity = true;
  const src = typeof params.src === 'string' ? params.src.trim() : '';
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(src);
  return Boolean(match && ALLOWED_WEBVIEW_PROTOCOLS.has(`${match[1].toLowerCase()}:`));
}
