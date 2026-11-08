import { describe, expect, it } from 'vitest';
import {
  isInternalBindingEvent,
  redactSecrets,
  redactValue,
  stripPostData,
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

describe('redaction variants', () => {
  it('matches urlencoded, form-encoded and double-JSON forms', () => {
    const p = 'p@ss word9';
    expect(redactSecrets(`a=${encodeURIComponent(p)}&b=1`, [p])).toBe('a=«segredo»&b=1');
    expect(redactSecrets(`a=${encodeURIComponent(p).replace(/%20/g, '+')}`, [p])).toBe('a=«segredo»');
    const q = 'a"b\\c9';
    expect(redactSecrets(JSON.stringify(JSON.stringify({ v: q })), [q])).not.toContain('b\\\\\\\\c9');
    expect(redactSecrets(JSON.stringify(JSON.stringify({ v: q })), [q])).toContain('«segredo»');
  });
});

describe('form encoding', () => {
  it('matches real x-www-form-urlencoded for ! and space', () => {
    const p = 'Pa ss!word9';
    expect(redactSecrets('pw=Pa+ss%21word9&x=1', [p])).toBe('pw=«segredo»&x=1');
  });
});

describe('stripPostData', () => {
  it('removes postData and postDataEntries from request', () => {
    const out = stripPostData({
      requestId: '1',
      request: { url: 'u', postData: 'x', postDataEntries: [{ bytes: 'eA==' }] },
    });
    expect(out).toEqual({ requestId: '1', request: { url: 'u' } });
  });
  it('passes through params without a request', () => {
    expect(stripPostData({ a: 1 })).toEqual({ a: 1 });
    expect(stripPostData(undefined)).toBeUndefined();
  });
});

describe('isInternalBindingEvent', () => {
  it('matches only __jrTeach bindings', () => {
    expect(isInternalBindingEvent('Runtime.bindingCalled', { name: '__jrTeachEvent' })).toBe(true);
    expect(isInternalBindingEvent('Runtime.bindingCalled', { name: 'other' })).toBe(false);
    expect(isInternalBindingEvent('Runtime.consoleAPICalled', { name: '__jrTeachEvent' })).toBe(false);
  });
});

describe('redactValue', () => {
  it('redacts string values and keys only, leaving numbers and arrays intact', () => {
    const otp = '483917';
    const msg = { ts: 1730212483917.25, arr: [4, 8, 3, 9, 1, 7], s: `x${otp}y`, [otp]: true, nested: [{ v: otp }] };
    expect(redactValue(msg, [otp])).toEqual({
      ts: 1730212483917.25,
      arr: [4, 8, 3, 9, 1, 7],
      s: 'x«segredo»y',
      '«segredo»': true,
      nested: [{ v: '«segredo»' }],
    });
  });
  it('matches secrets containing characters JSON escapes', () => {
    const q = 'a"b\\c9';
    expect(redactValue({ v: `pw ${q}` }, [q])).toEqual({ v: 'pw «segredo»' });
  });
  it('returns unchanged strings untouched', () => {
    expect(redactValue('nada "aqui"\n', [s])).toBe('nada "aqui"\n');
  });
});
