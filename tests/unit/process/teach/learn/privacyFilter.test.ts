import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXCLUSIONS,
  isExcluded,
  normalizeForMatch,
  redactTitle,
  redactUrl,
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
  it('drops Mercado Pago, PicPay, BTG Pactual and Outlook.com in an external browser', () => {
    expect(isExcluded({ app: 'Chrome', title: 'Mercado Pago - Sua conta' }, R)).toBe(true);
    expect(isExcluded({ app: 'Chrome', title: 'PicPay - Extrato' }, R)).toBe(true);
    expect(isExcluded({ app: 'Chrome', title: 'BTG Pactual | Investimentos' }, R)).toBe(true);
    expect(isExcluded({ app: 'Chrome', title: 'Email – Ana – Outlook.com' }, R)).toBe(true);
    expect(isExcluded({ app: 'JR Bot', title: 'Inbox', url: 'https://outlook.com/mail' }, R)).toBe(true);
  });
  it('keeps the corporate Outlook on office.com', () => {
    expect(isExcluded({ app: 'JR Bot', title: 'Inbox', url: 'https://outlook.office.com/mail' }, R)).toBe(false);
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
    const rules: LearnExclusion[] = [
      { id: 'd', kind: 'domain', pattern: 'https://portal.exemplo.com/x', builtin: false },
    ];
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
  it('masks numbers with 7+ digits across separators and vehicle plates', () => {
    expect(redactTitle('RG 12.345.678-9 - Cadastro')).toBe('RG # - Cadastro');
    expect(redactTitle('CPF 123.456.789')).toBe('CPF #');
    expect(redactTitle('Placa ABC-1D23 - Frota')).toBe('Placa [placa] - Frota');
    expect(redactTitle('Placa ABC1234')).toBe('Placa [placa]');
    expect(redactTitle('Medição 12 da obra')).toBe('Medição 12 da obra');
  });
  it('drops titles with more secret words, in English too', () => {
    for (const title of [
      'Add a credit card',
      'Login - Portal do fornecedor',
      'Sign in to your account',
      'Enter the OTP',
      'MFA setup',
      'Autenticação em dois fatores',
      'Cadastrar chave Pix',
    ]) {
      expect(redactTitle(title), title).toBeNull();
    }
  });
  it('drops titles with LGPD art. 11 sensitive data', () => {
    for (const title of [
      'Atestado médico - Ana.pdf',
      'Resultado do exame',
      'CID F32 - afastamento',
      'Holerite outubro',
      'Salário 2026.xlsx',
      'Sindicato dos trabalhadores',
      'Religião e trabalho',
      'Doença ocupacional',
      'Plano de saúde',
    ]) {
      expect(redactTitle(title), title).toBeNull();
    }
  });
  it('keeps ordinary work titles', () => {
    expect(redactTitle('Medição BMO.xlsx')).toBe('Medição BMO.xlsx');
    expect(redactTitle('Notas de crédito - Financeiro')).toBe('Notas de crédito - Financeiro');
    expect(redactTitle('Cardápio da semana')).toBe('Cardápio da semana');
    expect(redactTitle('Designing the plan')).toBe('Designing the plan');
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

describe('redactUrl', () => {
  it('keeps only origin and path, never the query or fragment', () => {
    expect(redactUrl('https://portal.exemplo.com/clientes/lista?cliente=Ana&cpf=1#top')).toBe(
      'https://portal.exemplo.com/clientes/lista'
    );
  });
  it('redacts numbers and e-mails in the path without producing ? or #', () => {
    const url = redactUrl('https://portal.exemplo.com/pedidos/9981234/ana@exemplo.com');
    expect(url).not.toMatch(/[?#]/);
    expect(url).not.toContain('9981234');
    expect(url).not.toContain('ana@exemplo.com');
    expect(url?.startsWith('https://portal.exemplo.com/pedidos/')).toBe(true);
  });
  it('drops a path that names a secret', () => {
    expect(redactUrl('https://portal.exemplo.com/senha/redefinir')).toBe('https://portal.exemplo.com');
  });
  it('returns the origin for the root and null for non-web urls', () => {
    expect(redactUrl('https://portal.exemplo.com/')).toBe('https://portal.exemplo.com');
    expect(redactUrl('file:///C:/x.txt')).toBeNull();
    expect(redactUrl('not a url')).toBeNull();
    expect(redactUrl(undefined)).toBeNull();
  });
});
