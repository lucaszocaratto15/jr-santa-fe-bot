import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCaptureScript } from '@/process/services/teach/recording/captureScript';

const SECRET = 'S3nh4-Ultra-Secreta';
const win = window as unknown as Record<string, unknown>;
let payloads: string[] = [];

beforeEach(() => {
  payloads = [];
  win.__jrTeachEvent = (json: string) => payloads.push(json);
  const html = readFileSync(resolve(process.cwd(), 'tests/fixtures/teach/portal.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>\s*$/i, '');
  // eslint-disable-next-line no-eval -- the capture script is a plain source string by design
  (0, eval)(buildCaptureScript());
});
afterEach(() => {
  delete win.__jrTeachEvent;
});

describe('portal fixture with capture script', () => {
  it('never emits the typed password when typing and submitting the login form', () => {
    const pw = document.getElementById('senha') as HTMLInputElement;
    const user = document.getElementById('usuario') as HTMLInputElement;
    user.value = 'maria';
    user.dispatchEvent(new Event('change', { bubbles: true }));
    pw.value = SECRET;
    pw.dispatchEvent(new Event('input', { bubbles: true }));
    pw.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('login')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads.some((p) => p.includes('maria'))).toBe(true);
    for (const p of payloads) expect(p).not.toContain(SECRET);
  });
});
