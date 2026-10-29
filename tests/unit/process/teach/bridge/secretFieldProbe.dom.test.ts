import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ webContents: { fromId: () => null } }));

const { buildSecretFieldProbe } = await import('@process/resources/builtinMcp/cdpBridge');

const SECRET = 'S3nh@Forte9';
// eslint-disable-next-line no-eval
const runProbe = (secrets: string[]): unknown => (0, eval)(buildSecretFieldProbe(secrets));

describe('secret field probe (R13)', () => {
  it('returns true only when an input or textarea holds a live secret', () => {
    document.body.innerHTML = '<input id="u" /><textarea id="t"></textarea>';
    expect(runProbe([SECRET])).toBe(false);
    (document.getElementById('u') as HTMLInputElement).value = SECRET;
    expect(runProbe([SECRET])).toBe(true);
    (document.getElementById('u') as HTMLInputElement).value = `${SECRET}x`;
    expect(runProbe([SECRET])).toBe(false);
    (document.getElementById('t') as HTMLTextAreaElement).value = SECRET;
    expect(runProbe(['other', SECRET])).toBe(true);
  });

  it('walks open shadow roots', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    root.appendChild(input);
    expect(runProbe([SECRET])).toBe(false);
    input.value = SECRET;
    expect(runProbe([SECRET])).toBe(true);
  });

  it('returns a boolean, never a value', () => {
    document.body.innerHTML = `<input value="${SECRET}" />`;
    expect(typeof runProbe([SECRET])).toBe('boolean');
  });
});
