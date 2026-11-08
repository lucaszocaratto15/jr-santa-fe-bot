import { describe, expect, it } from 'vitest';
import { sanitizeUrl } from '@/process/services/teach/recording/urlSanitizer';

describe('sanitizeUrl', () => {
  it('masks secret query parameter values', () => {
    expect(sanitizeUrl('https://p.gov.br/login?user=x&pw=S3nh@')).toBe('https://p.gov.br/login?user=x&pw=«segredo»');
    expect(sanitizeUrl('https://a.test/cb?code=abc&state=1&senha=1')).toBe(
      'https://a.test/cb?code=«segredo»&state=1&senha=«segredo»'
    );
    expect(sanitizeUrl('https://a.test/?api_key=k&Password=p&otp=1&pin=2&auth=3')).toBe(
      'https://a.test/?api_key=«segredo»&Password=«segredo»&otp=«segredo»&pin=«segredo»&auth=«segredo»'
    );
  });

  it('masks secret fragment parameters', () => {
    expect(sanitizeUrl('https://a.test/app#access_token=abc&token_type=bearer')).toBe(
      'https://a.test/app#access_token=«segredo»&token_type=«segredo»'
    );
    expect(sanitizeUrl('https://a.test/#/route?id_token=abc&tab=2')).toBe(
      'https://a.test/#/route?id_token=«segredo»&tab=2'
    );
  });

  it('keeps ordinary parameters and drops userinfo', () => {
    expect(sanitizeUrl('https://a.test/busca?q=nota+fiscal&page=2#top')).toBe(
      'https://a.test/busca?q=nota+fiscal&page=2#top'
    );
    expect(sanitizeUrl('https://maria:S3nh@@a.test/x')).toBe('https://a.test/x');
    expect(sanitizeUrl('https://a.test/?keyword=pneu&zipcode=1')).toBe('https://a.test/?keyword=pneu&zipcode=1');
  });

  it('reduces malformed or non-web urls', () => {
    expect(sanitizeUrl('not a url')).toBe('');
    expect(sanitizeUrl('')).toBe('');
    expect(sanitizeUrl('about:blank')).toBe('about:blank');
    expect(sanitizeUrl('data:text/html,pw=S3nh@')).toBe('');
  });
});
