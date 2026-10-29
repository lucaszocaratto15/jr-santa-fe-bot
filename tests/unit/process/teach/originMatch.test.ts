import { describe, expect, it } from 'vitest';
import { normalizeOrigin, originAllowed } from '@/process/services/teach/originMatch';

describe('normalizeOrigin', () => {
  it('adds https to a bare host', () => {
    expect(normalizeOrigin('portal.gov.br')).toBe('https://portal.gov.br');
  });
  it('strips path and query', () => {
    expect(normalizeOrigin('https://portal.gov.br/login?x=1')).toBe('https://portal.gov.br');
  });
  it('returns null for garbage', () => {
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
  });
});

describe('originAllowed', () => {
  const allowed = ['https://portal.gov.br'];
  it('matches the exact origin', () => {
    expect(originAllowed('https://portal.gov.br/a', allowed)).toBe(true);
  });
  it('rejects lookalike hosts', () => {
    expect(originAllowed('https://portal.gov.br.evil.com/a', allowed)).toBe(false);
  });
  it('rejects a different scheme', () => {
    expect(originAllowed('http://portal.gov.br/a', allowed)).toBe(false);
  });
  it('rejects subdomains', () => {
    expect(originAllowed('https://sub.portal.gov.br/a', allowed)).toBe(false);
  });
  it('rejects an unparsable page url', () => {
    expect(originAllowed('not a url', allowed)).toBe(false);
  });
});
