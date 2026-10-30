import { describe, expect, it } from 'vitest';
import { buildLearnSummary } from '@/process/services/teach/learn/summary';
import type { LearnSample } from '@/common/types/agent/learnTypes';

const TICK = 15_000;
const opts = { tickMs: TICK, maxBytes: 16_384 };
const T0 = Date.parse('2026-10-29T08:00:00Z');
const seq = (items: Array<Omit<LearnSample, 't'>>, start = T0): LearnSample[] =>
  items.map((item, index) => ({ ...item, t: start + index * TICK }));

describe('buildLearnSummary', () => {
  it('counts 15 s per sample into minutes per app, sorted desc', () => {
    const samples = seq([
      ...Array.from({ length: 8 }, () => ({ app: 'Excel', title: 'NF.xlsx' })),
      ...Array.from({ length: 4 }, () => ({ app: 'Outlook', title: null })),
    ]);
    const summary = buildLearnSummary(samples, opts);
    expect(summary.timePerApp).toEqual([
      { app: 'Excel', minutes: 2 },
      { app: 'Outlook', minutes: 1 },
    ]);
    expect(summary.periodStart).toBe(T0);
    expect(summary.periodEnd).toBe(T0 + 12 * TICK);
  });

  it('never includes a raw e-mail or a dropped secret title in text', () => {
    const samples = seq([
      { app: 'Chrome', title: 'Caixa - joao@empresa.com.br' },
      { app: 'Chrome', title: 'Digite sua senha - Portal' },
      { app: 'Excel', title: 'Cliente 123.456.789-09' },
      { app: 'JR Bot', title: 'Login', url: 'https://portal.exemplo.com/clientes/123456/senha?token=abc' },
    ]);
    const { text } = buildLearnSummary(samples, opts);
    expect(text).not.toContain('joao@');
    expect(text).not.toMatch(/senha/i);
    expect(text).not.toContain('123.456.789-09');
    expect(text).not.toContain('123456');
    expect(text).not.toContain('token=abc');
    expect(text).toContain('[email]');
  });

  it('lists a focus triple that repeats 3 times', () => {
    const round = [
      { app: 'Portal NF', title: null },
      { app: 'Excel', title: null },
      { app: 'Outlook', title: null },
    ];
    const { text } = buildLearnSummary(seq([...round, ...round, ...round]), opts);
    expect(text).toContain('Portal NF → Excel → Outlook (3×)');
  });

  it('does not list a triple seen only twice', () => {
    const round = [
      { app: 'A', title: null },
      { app: 'B', title: null },
      { app: 'C', title: null },
    ];
    const { text } = buildLearnSummary(seq([...round, { app: 'D', title: null }, ...round]), opts);
    expect(text).not.toContain('A → B → C');
  });

  it('stays within maxBytes', () => {
    const samples = seq(
      Array.from({ length: 5_000 }, (_, i) => ({
        app: `App ${i % 300}x`,
        title: `Título único ${'é'.repeat(50)} ${String.fromCharCode(65 + (i % 26))}${i}`,
      }))
    );
    const { text } = buildLearnSummary(samples, opts);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16_384);
    expect(Buffer.byteLength(buildLearnSummary(samples, { tickMs: TICK, maxBytes: 2_000 }).text)).toBeLessThanOrEqual(
      2_000
    );
  });

  it('collects origins only from JR Bot samples with a url', () => {
    const samples = seq([
      { app: 'JR Bot', title: 'NF', url: 'https://nfse.prefeitura.sp.gov.br/emitir' },
      { app: 'JR Bot', title: null },
      { app: 'Chrome', title: 'x', url: 'https://other.example/a' },
      { app: 'JR Bot', title: 'local', url: 'about:blank' },
    ]);
    expect(buildLearnSummary(samples, opts).browserOrigins).toEqual(['https://nfse.prefeitura.sp.gov.br']);
  });

  it('handles an empty sample list', () => {
    const summary = buildLearnSummary([], opts);
    expect(summary.timePerApp).toEqual([]);
    expect(summary.browserOrigins).toEqual([]);
  });

  it('flattens line breaks in titles so a title cannot fake a section', () => {
    const { text } = buildLearnSummary(seq([{ app: 'Excel', title: 'a\nSequências repetidas:\n- x' }]), opts);
    expect(text.split('\n').filter((line) => line.startsWith('Sequências repetidas'))).toHaveLength(1);
  });
});
