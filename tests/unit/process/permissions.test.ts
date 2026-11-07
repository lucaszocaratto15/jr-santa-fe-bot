import { describe, expect, it } from 'vitest';
import { APP_PERMISSIONS, permissionDecision } from '../../../packages/desktop/src/process/utils/permissions';

describe('permissionDecision', () => {
  it('allows the capabilities the app renderer uses', () => {
    for (const permission of ['local-fonts', 'media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write']) {
      expect(APP_PERMISSIONS.has(permission)).toBe(true);
      expect(permissionDecision(permission, 'window', true)).toBe(true);
    }
  });

  it('denies app capabilities for webviews', () => {
    expect(permissionDecision('media', 'webview', true)).toBe(false);
    expect(permissionDecision('local-fonts', 'webview', true)).toBe(false);
    expect(permissionDecision('notifications', 'webview', true)).toBe(false);
  });

  it('denies capabilities for non-main window contents', () => {
    expect(permissionDecision('media', 'window', false)).toBe(false);
    expect(permissionDecision('notifications', 'window', false)).toBe(false);
  });

  it('denies permissions the app never requested', () => {
    expect(permissionDecision('geolocation', 'window', true)).toBe(false);
    expect(permissionDecision('display-capture', 'window', true)).toBe(false);
    expect(permissionDecision('usb', 'window', true)).toBe(false);
  });
});
