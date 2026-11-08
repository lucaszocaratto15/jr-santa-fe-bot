/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Capabilities the app renderer actually uses:
 * - local-fonts: appearance font picker (window.queryLocalFonts)
 * - media: speech input (navigator.mediaDevices.getUserMedia)
 * - notifications: in-app browser notifications
 * - clipboard-*: copy buttons (navigator.clipboard)
 */
export const APP_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'local-fonts',
  'media',
  'notifications',
]);

/**
 * Permission requests are approved only for the main renderer window and only
 * for capabilities the app itself relies on. Webviews (HTML preview, in-app
 * browser) are guests and never inherit them.
 */
export function permissionDecision(permission: string, contentsType: string, isMainRenderer: boolean): boolean {
  return isMainRenderer && contentsType === 'window' && APP_PERMISSIONS.has(permission);
}
