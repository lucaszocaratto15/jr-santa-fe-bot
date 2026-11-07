import { describe, expect, it } from 'vitest';
import { sanitizeWebviewPreferences } from '../../../packages/desktop/src/process/utils/webviewSecurity';

describe('sanitizeWebviewPreferences', () => {
  it('strips preload and forces isolation flags', () => {
    const preferences = {
      preload: '/tmp/evil.js',
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
    };
    expect(sanitizeWebviewPreferences(preferences, { src: 'https://example.com' })).toBe(true);
    expect(preferences.preload).toBeUndefined();
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.webSecurity).toBe(true);
  });

  it('allows web and local preview schemes', () => {
    for (const src of [
      'https://example.com',
      'http://127.0.0.1:5173',
      'file:///tmp/preview.html',
      'data:text/html,<p>ok</p>',
      'blob:https://example.com/123',
      'chrome-extension://abc/page.html',
      'about:blank',
    ]) {
      expect(sanitizeWebviewPreferences({}, { src })).toBe(true);
    }
  });

  it('rejects unknown, javascript and missing schemes', () => {
    for (const src of ['javascript:alert(1)', 'vbscript:msgbox(1)', 'ftp://example.com', 'filex://tmp', '', undefined]) {
      expect(sanitizeWebviewPreferences({}, { src })).toBe(false);
    }
  });
});
