import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../../../packages/desktop/src/renderer/index.html', import.meta.url), 'utf8');

describe('renderer CSP', () => {
  it('declares a Content-Security-Policy meta', () => {
    expect(html).toMatch(/http-equiv="Content-Security-Policy"/);
  });

  it('blocks remote and object script execution', () => {
    expect(html).toMatch(/script-src 'self'/);
    expect(html).not.toMatch(/script-src[^;"]*https:/);
    expect(html).toMatch(/object-src 'none'/);
  });

  it('keeps the local backend and HMR reachable', () => {
    expect(html).toMatch(/connect-src[^;"]*http:\/\/127\.0\.0\.1:\*/);
    expect(html).toMatch(/connect-src[^;"]*ws:\/\/localhost:\*/);
  });
});
