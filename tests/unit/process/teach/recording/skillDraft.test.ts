import { describe, expect, it } from 'vitest';
import {
  buildDraftPrompt,
  parseDraft,
  withDraftDescription,
  withDraftName,
} from '@process/services/teach/recording/skillDraft';

const VALID = `---
name: jr-tarefa-relatorio-nfs
description: Baixa o relatório de NFs do mês no portal da prefeitura.
source: taught
created: 2026-10-29
---

## Entradas
- Mês de referência

## Logins
- \`cofre:Portal Prefeitura\`

## Passos
1. Abrir https://portal.exemplo.gov.br
2. Clicar no campo "Usuário" e chamar \`vault_fill\`
3. Relatórios → Notas fiscais
4. Escolher o mês e clicar em "Gerar"

## Confirmar antes de
- Clicar em "Emitir"

## Como saber que deu certo
- O PDF aparece em Downloads.

## Se algo estiver diferente
- Pare e peça ajuda; não tente adivinhar.
`;

describe('parseDraft', () => {
  it('accepts a valid draft and extracts its lists', () => {
    expect(parseDraft(VALID)).toEqual({
      ok: true,
      name: 'jr-tarefa-relatorio-nfs',
      description: 'Baixa o relatório de NFs do mês no portal da prefeitura.',
      inputs: ['Mês de referência'],
      logins: ['Portal Prefeitura'],
      steps: [
        'Abrir https://portal.exemplo.gov.br',
        'Clicar no campo "Usuário" e chamar `vault_fill`',
        'Relatórios → Notas fiscais',
        'Escolher o mês e clicar em "Gerar"',
      ],
      confirmBefore: ['Clicar em "Emitir"'],
    });
  });

  it('accepts CRLF line endings and starred bullets', () => {
    const draft = VALID.replace('- Mês de referência', '* Mês de referência').replace(/\n/g, '\r\n');
    const parsed = parseDraft(draft);
    expect(parsed.ok && parsed.inputs).toEqual(['Mês de referência']);
  });

  it.each([
    ['without the prefix', 'relatorio-nfs'],
    ['with uppercase letters', 'jr-tarefa-Relatorio'],
    ['too short', 'jr-tarefa-ab'],
    ['with a path', 'jr-tarefa-../../etc'],
    ['too long', `jr-tarefa-${'a'.repeat(49)}`],
  ])('rejects a name %s', (_label, name) => {
    const parsed = parseDraft(VALID.replace('jr-tarefa-relatorio-nfs', name));
    expect(parsed.ok).toBe(false);
  });

  it('rejects a draft without frontmatter', () => {
    expect(parseDraft('## Passos\n1. Abrir o site\n')).toEqual({
      ok: false,
      code: 'no_frontmatter',
      error: expect.any(String),
    });
  });

  it('rejects a missing description', () => {
    expect(parseDraft(VALID.replace(/^description:.*$/m, '')).ok).toBe(false);
  });

  it('rejects a draft without a ## Passos section', () => {
    const parsed = parseDraft(VALID.replace('## Passos', '## Etapas'));
    expect(parsed).toEqual({ ok: false, code: 'no_steps', error: expect.stringContaining('Passos') });
  });

  it('rejects an empty ## Passos section', () => {
    const parsed = parseDraft(VALID.replace(/## Passos[\s\S]*?## Confirmar/, '## Passos\n\n## Confirmar'));
    expect(parsed.ok).toBe(false);
  });

  it('rejects drafts larger than 64 KB', () => {
    const parsed = parseDraft(`${VALID}\n${'x'.repeat(64 * 1024)}`);
    expect(parsed).toEqual({ ok: false, code: 'too_large', error: expect.stringContaining('64 KB') });
  });

  it('keeps login items that do not use the cofre: prefix', () => {
    const parsed = parseDraft(VALID.replace('- `cofre:Portal Prefeitura`', '- Nenhum'));
    expect(parsed.ok && parsed.logins).toEqual(['Nenhum']);
  });
});

describe('withDraftName', () => {
  it('replaces only the frontmatter name', () => {
    const renamed = withDraftName(VALID, 'jr-tarefa-nfs-prefeitura');
    const parsed = parseDraft(renamed);
    expect(parsed.ok && parsed.name).toBe('jr-tarefa-nfs-prefeitura');
    expect(renamed.replace('"jr-tarefa-nfs-prefeitura"', 'jr-tarefa-relatorio-nfs')).toBe(VALID);
  });

  it('writes the name as a quoted scalar', () => {
    expect(withDraftName(VALID, 'jr-tarefa-nfs')).toContain('\nname: "jr-tarefa-nfs"\n');
  });
});

describe('withDraftDescription', () => {
  it('replaces the frontmatter description with a single line, keeping $ patterns literal', () => {
    const parsed = parseDraft(withDraftDescription(VALID, 'Baixa\n  as NFs $1 do mês'));
    expect(parsed.ok && parsed.description).toBe('Baixa as NFs $1 do mês');
  });

  it('quotes YAML-hostile descriptions and round-trips them', () => {
    const hostile = 'Emite a NF: mensal # rápido';
    const text = withDraftDescription(VALID, hostile);
    expect(text).toContain('\ndescription: "Emite a NF: mensal # rápido"\n');
    const parsed = parseDraft(text);
    expect(parsed.ok && parsed.description).toBe(hostile);
  });

  it('round-trips a description containing double quotes and backslashes', () => {
    const quoted = 'Baixa o "Relatório \\ mensal" da prefeitura';
    const text = withDraftDescription(VALID, quoted);
    expect(text).toContain(`description: ${JSON.stringify(quoted)}`);
    const parsed = parseDraft(text);
    expect(parsed.ok && parsed.description).toBe(quoted);
  });

  it('still reads plain and single-quoted descriptions', () => {
    const single = parseDraft(VALID.replace(/^description: .*$/m, "description: 'It''s mensal'"));
    expect(single.ok && single.description).toBe("It's mensal");
  });
});

describe('buildDraftPrompt', () => {
  const timeline = '1. Abriu https://portal.exemplo.gov.br\n2. Clicou no botão "Entrar"';
  const prompt = buildDraftPrompt('Baixar o relatório de NFs', timeline);

  it('includes the timeline verbatim, the description and the submit tool', () => {
    expect(prompt).toContain(timeline);
    expect(prompt).toContain('Baixar o relatório de NFs');
    expect(prompt).toContain('teach_submit_draft');
    expect(prompt.startsWith('📋 Gerando tarefa a partir da gravação…')).toBe(true);
  });

  it('asks for the required frontmatter and sections', () => {
    for (const piece of [
      'name: jr-tarefa-',
      'submit: true',
      'description:',
      'source: taught',
      'created: ',
      '## Entradas',
      '## Logins',
      'cofre:',
      '## Passos',
      'vault_fill',
      'secure_input',
      '## Confirmar antes de',
      '## Como saber que deu certo',
      '## Se algo estiver diferente',
      'não tente adivinhar',
      'nunca coordenadas',
    ]) {
      expect(prompt).toContain(piece);
    }
  });
});
