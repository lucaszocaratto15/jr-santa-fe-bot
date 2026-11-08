import { describe, expect, it } from 'vitest';
import type { HandbookActivityBody } from '@/common/types/agent/handbookTypes';
import { activityFlowchart, mermaidLabel, roleFlowchart } from '@process/services/teach/handbook/flowchart';

const activity = (overrides: Partial<HandbookActivityBody> = {}): HandbookActivityBody => ({
  title: 'Lançar NF',
  description: '',
  frequency: 'daily',
  steps: [{ text: 'Abrir o portal' }, { text: 'Emitir' }],
  confirmBefore: [],
  ...overrides,
});

describe('activityFlowchart', () => {
  it('is a top-down flowchart with the steps in order', () => {
    const chart = activityFlowchart(activity());
    expect(chart).toContain('flowchart TD');
    expect(chart).toContain('s1["1. Abrir o portal"]');
    expect(chart).toContain('start --> s1');
    expect(chart).toContain('s1 --> s2');
    expect(chart).toContain('s2 --> finish');
  });

  it('escapes quotes and strips brackets and pipes from step labels', () => {
    const chart = activityFlowchart(activity({ steps: [{ text: 'Clicar em "Emitir" [x] | y' }] }));
    const label = chart.split('\n').find((line) => line.trim().startsWith('s1['));
    expect(label).toContain('#quot;Emitir#quot;');
    expect(label?.slice(label.indexOf('"'))).not.toMatch(/\[x\]|\|/);
    expect(mermaidLabel('a<script>b{c}`d`')).toBe('"a script b c d"');
    expect(mermaidLabel('x'.repeat(100)).length).toBeLessThanOrEqual(62);
  });

  it('confirmBefore items become decision nodes', () => {
    const chart = activityFlowchart(activity({ confirmBefore: ['Valor da nota', 'CNPJ'] }));
    expect(chart).toContain('c1{"Confirmar: Valor da nota"}');
    expect(chart).toContain('c2{"Confirmar: CNPJ"}');
    expect(chart).toContain('s1 --> c1');
    expect(chart).toContain('c1 --> c2');
    expect(chart).toContain('c2 -->|sim| s2');
    expect(chart).toContain('c1 -->|não| stop');
  });

  it('handles an activity without steps', () => {
    expect(activityFlowchart(activity({ steps: [] }))).toContain('start --> finish');
  });
});

describe('roleFlowchart', () => {
  it('roleFlowchart groups activities by frequency', () => {
    const chart = roleFlowchart(
      [
        activity({ title: 'Lançar NF', frequency: 'daily' }),
        activity({ title: 'Fechar mês', frequency: 'occasional' }),
        activity({ title: 'Conferir banco', frequency: 'daily' }),
      ],
      'Auxiliar de escritório'
    );
    expect(chart).toContain('role(["Auxiliar de escritório"])');
    expect(chart).toContain('daily["Diárias"]');
    expect(chart).toContain('occasional["Eventuais"]');
    expect(chart).not.toContain('weekly');
    expect(chart).toContain('daily --> a1');
    expect(chart).toContain('daily --> a2');
    expect(chart).toContain('occasional --> a3');
  });
});
