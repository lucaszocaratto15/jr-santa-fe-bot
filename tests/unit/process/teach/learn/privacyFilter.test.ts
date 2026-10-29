import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXCLUSIONS,
  isExcluded,
  normalizeForMatch,
  redactTitle,
} from '@/process/services/teach/learn/privacyFilter';
import type { LearnExclusion } from '@/common/types/agent/learnTypes';

const R = DEFAULT_EXCLUSIONS;

describe('DEFAULT_EXCLUSIONS', () => {
  it('are all builtin with unique ids', () => {
    expect(R.every((rule) => rule.builtin)).toBe(true);
    expect(new Set(R.map((rule) => rule.id)).size).toBe(R.length);
  });
});

describe('isExcluded with the default rules', () => {
  it('drops a bank title in an external browser', () => {
    expect(isExcluded({ app: 'Google Chrome', title: 'Itaú - Internet Banking', url: undefined }, R)).toBe(true);
  });
  it('drops a bank subdomain seen in the JR Bot browser', () => {
    expect(isExcluded({ app: 'JR Bot', title: 'x', url: 'https://www2.bb.com.br/aapf' }, R)).toBe(true);
  });
  it('drops WhatsApp with no title', () => {
    expect(isExcluded({ app: 'WhatsApp', title: null }, R)).toBe(true);
  });
  it('drops a personal Gmail inbox', () => {
    expect(isExcluded({ app: 'Chrome', title: 'Caixa de entrada - joao@gmail.com - Gmail' }, R)).toBe(true);
  });
  it('keeps the company Gmail inbox', () => {
    expect(isExcluded({ app: 'Chrome', title: 'Caixa de entrada (3) - fiscal@jrsantafe.com.br - Gmail' }, R)).toBe(
      false
    );
  });
  it("does not treat 'Caixa' alone as a bank", () => {
    expect(isExcluded({ app: 'Excel', title: 'Caixa de entrada.xlsx' }, R)).toBe(false);
  });
  it('needs a dot boundary for a domain suffix', () => {
    expect(isExcluded({ app: 'x', title: 'y', url: 'https://notbb.com.br' }, R)).toBe(false);
  });
  it('tests a domain rule against the title when there is no url', () => {
    expect(isExcluded({ app: 'Firefox', title: 'web.whatsapp.com - Mozilla Firefox' }, R)).toBe(true);
  });
});

describe('isExcluded with custom rules', () => {
  it('matches apps without case or accents', () => {
    expect(isExcluded({ app: 'ITAU', title: null }, [{ id: 'a', kind: 'app', pattern: 'itaú', builtin: false }])).toBe(
      true
    );
  });
  it('ignores a rule with an empty pattern', () => {
    const rules: LearnExclusion[] = [{ id: 'e', kind: 'title', pattern: '  ', builtin: false }];
    expect(isExcluded({ app: 'Excel', title: 'NF.xlsx' }, rules)).toBe(false);
  });
  it('matches a domain rule given with a scheme and path', () => {
    const rules: LearnExclusion[] = [{ id: 'd', kind: 'domain', pattern: 'https://portal.exemplo.com/x', builtin: false }];
    expect(isExcluded({ app: 'JR Bot', title: null, url: 'https://a.portal.exemplo.com/y' }, rules)).toBe(true);
  });
  it('keeps everything with no rules', () => {
    expect(isExcluded({ app: 'Excel', title: 'NF.xlsx' }, [])).toBe(false);
  });
});

describe('redactTitle', () => {
  it('replaces e-mails', () => {
    expect(redactTitle('Caixa de entrada - fiscal@jrsantafe.com.br')).toBe('Caixa de entrada - [email]');
  });
  it('replaces CPF/CNPJ and long digit runs', () => {
    expect(redactTitle('Cliente 123.456.789-09 pedido 99812')).toBe('Cliente [doc] pedido #');
    expect(redactTitle('Empresa 12.345.678/0001-90')).toBe('Empresa [doc]');
  });
  it('masks a card number', () => {
    expect(redactTitle('Pagamento 4111 1111 1111 1111')).not.toMatch(/\d{4}/);
  });
  it('drops titles that mention a secret', () => {
    expect(redactTitle('Digite sua senha - Portal')).toBeNull();
    expect(redactTitle('Código de verificação')).toBeNull();
    expect(redactTitle('Enter PASSWORD')).toBeNull();
    expect(redactTitle('Digite o PIN')).toBeNull();
  });
  it('caps at 120 chars', () => {
    expect(redactTitle('a'.repeat(300))?.length).toBe(120);
  });
  it('passes null through', () => {
    expect(redactTitle(null)).toBeNull();
    expect(redactTitle('   ')).toBeNull();
  });
});

describe('normalizeForMatch', () => {
  it('lowercases and strips accents', () => {
    expect(normalizeForMatch('Itaú Econômica')).toBe('itau economica');
  });
});
