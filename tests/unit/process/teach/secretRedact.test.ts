import { describe, expect, it } from 'vitest';
import {
  isInternalBindingEvent,
  redactSecrets,
  shouldClearSecretsOn,
} from '@process/resources/builtinMcp/secretRedact';

const s = 'S3nh@Forte9';

describe('redactSecrets', () => {
  it('redacts as-is in JSON', () => {
    expect(redactSecrets(`{"value":"${s}"}`, [s])).toBe('{"value":"«segredo»"}');
  });
  it('redacts reversed, base64 and separator-joined', () => {
    expect(redactSecrets('9etroF@hn3S', [s])).toBe('«segredo»');
    expect(redactSecrets(Buffer.from(s).toString('base64'), [s])).toBe('«segredo»');
    expect(redactSecrets('S 3 n h @ F o r t e 9', [s])).toBe('«segredo»');
    expect(redactSecrets('S,3,n,h,@,F,o,r,t,e,9', [s])).toBe('«segredo»');
  });
  it('leaves unrelated text and short secrets alone', () => {
    expect(redactSecrets('nada aqui', [s])).toBe('nada aqui');
    expect(redactSecrets('abc', ['ab'])).toBe('abc');
  });
  it('matches secrets with characters JSON escapes', () => {
    const q = 'a"b\\c9';
    expect(redactSecrets(JSON.stringify({ v: q }), [q])).toBe('{"v":"«segredo»"}');
  });
  it('handles multiple secrets and repeats', () => {
    expect(redactSecrets(`${s} ${s} OtherPw1`, [s, 'OtherPw1'])).toBe('«segredo» «segredo» «segredo»');
  });
});

describe('shouldClearSecretsOn', () => {
  it('clears on main-frame navigation only', () => {
    expect(shouldClearSecretsOn('Page.frameNavigated', { frame: { id: '1' } })).toBe(true);
    expect(shouldClearSecretsOn('Page.frameNavigated', { frame: { id: '2', parentId: '1' } })).toBe(false);
    expect(shouldClearSecretsOn('Page.loadEventFired', {})).toBe(false);
    expect(shouldClearSecretsOn('Page.frameNavigated', undefined)).toBe(false);
  });
});

describe('isInternalBindingEvent', () => {
  it('matches only __jrTeach bindings', () => {
    expect(isInternalBindingEvent('Runtime.bindingCalled', { name: '__jrTeachEvent' })).toBe(true);
    expect(isInternalBindingEvent('Runtime.bindingCalled', { name: 'other' })).toBe(false);
    expect(isInternalBindingEvent('Runtime.consoleAPICalled', { name: '__jrTeachEvent' })).toBe(false);
  });
});
