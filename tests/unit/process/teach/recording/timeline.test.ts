import { describe, expect, it } from 'vitest';
import { REDACTED } from '@process/resources/builtinMcp/secretRedact';
import type { TeachEvent } from '@process/services/teach/recording/recorder';
import { summarizeEvents } from '@process/services/teach/recording/timeline';

const U = 'https://portal.gov.br/home';
const ev = (e: Partial<TeachEvent> & Pick<TeachEvent, 'kind'>): TeachEvent => ({ t: 0, tab: 1, url: U, ...e });

describe('summarizeEvents', () => {
  it('returns empty string for no events', () => {
    expect(summarizeEvents([])).toBe('');
  });

  it('renders a full fixture, collapsing inputs and dropping clicks before inputs', () => {
    const user = [{ role: 'textbox', name: 'Usuário' }, { css: '#user' }];
    const pass = [{ label: 'Senha' }];
    const events: TeachEvent[] = [
      ev({ kind: 'navigate', url: 'https://portal.gov.br/login' }),
      ev({ kind: 'click', target: user }),
      ev({ kind: 'input', target: user, value: 'j' }),
      ev({ kind: 'input', target: user, value: 'joao' }),
      ev({ kind: 'click', target: pass }),
      ev({ kind: 'input', target: pass, value: REDACTED }),
      ev({ kind: 'key', key: 'Enter' }),
      ev({ kind: 'click', target: [{ role: 'button', name: 'Gerar relatório' }] }),
      ev({ kind: 'tab-open', tab: 2, url: 'https://portal.gov.br/rel' }),
      ev({ kind: 'tab-switch', tab: 2, url: 'https://portal.gov.br/rel' }),
      ev({ kind: 'submit', tab: 2, url: 'https://portal.gov.br/rel', target: [{ css: 'form#f' }] }),
      ev({ kind: 'download', tab: 2, url: 'https://portal.gov.br/rel', fileName: 'relatorio.pdf' }),
    ];
    expect(summarizeEvents(events)).toBe(
      [
        '1. Navegou para https://portal.gov.br/login (aba 1)',
        '2. Preencheu campo "Usuário" com joao',
        '3. Preencheu campo "Senha" com «segredo»',
        '4. Pressionou a tecla Enter (aba 1, portal.gov.br)',
        '5. Clicou em botão "Gerar relatório" (aba 1, portal.gov.br)',
        '6. Abriu nova aba: https://portal.gov.br/rel',
        '7. Trocou para a aba 2 (portal.gov.br)',
        '8. Enviou o formulário "form#f" (aba 2, portal.gov.br)',
        '9. Baixou arquivo relatorio.pdf',
      ].join('\n')
    );
  });

  it('keeps clicks not followed by an input on the same element', () => {
    const out = summarizeEvents([
      ev({ kind: 'click', target: [{ text: 'Entrar' }] }),
      ev({ kind: 'input', target: [{ label: 'CPF' }], value: '1' }),
    ]);
    expect(out).toBe('1. Clicou em elemento "Entrar" (aba 1, portal.gov.br)\n2. Preencheu campo "CPF" com 1');
  });

  it('uses best locator order role+name, label, text, placeholder, attr, css', () => {
    const out = summarizeEvents([
      ev({ kind: 'input', target: [{ css: '#a', placeholder: 'Digite', attr: '[x]' }], value: 'v' }),
    ]);
    expect(out).toBe('1. Preencheu campo "Digite" com v');
  });
});
