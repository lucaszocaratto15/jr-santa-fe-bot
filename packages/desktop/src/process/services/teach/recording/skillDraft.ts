/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Taught-task skill drafts: the fixed prompt that asks the bot to turn a recording timeline
 * into a SKILL.md, and the validator for what the bot submits back. Pure: no I/O.
 */

export type TeachDraft = {
  name: string;
  description: string;
  inputs: string[];
  steps: string[];
  confirmBefore: string[];
  logins: string[];
};

export type ParsedDraft = ({ ok: true } & TeachDraft) | { ok: false; error: string };

/** Taught skills are named `jr-tarefa-<slug>`. */
export const TAUGHT_SKILL_NAME_RE = /^jr-tarefa-[a-z0-9-]{3,48}$/;
export const MAX_DRAFT_BYTES = 64 * 1024;

/** Visible first line of the prompt message in the transcript. */
export const DRAFT_PROMPT_HEADER = '📋 Gerando tarefa a partir da gravação…';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
const LOGIN_RE = /cofre:\s*([^`\n]+?)\s*`?\s*$/;

const today = (): string => new Date().toISOString().slice(0, 10);

/** Instruction sent to the bot (as a normal user message) after a recording stops. */
export function buildDraftPrompt(description: string, timeline: string): string {
  return [
    DRAFT_PROMPT_HEADER,
    '',
    'Transforme esta demonstração numa tarefa. Chame a ferramenta `teach_submit_draft` com um SKILL.md completo no parâmetro `markdown`. Não escreva o rascunho no chat.',
    '',
    `O que a tarefa faz, nas palavras do funcionário: ${description.trim()}`,
    '',
    'O SKILL.md deve seguir exatamente este formato:',
    '',
    '---',
    'name: jr-tarefa-<apelido curto: letras minúsculas, números e hífens>',
    'description: <uma frase simples dizendo o que a tarefa faz>',
    'source: taught',
    `created: ${today()}`,
    '---',
    '',
    '## Entradas',
    '- O que perguntar ao funcionário a cada execução (ex.: mês de referência). Valores da gravação que mudam a cada vez viram entradas.',
    '',
    '## Logins',
    '- `cofre:<nome do item no cofre>` para cada site que pede login. Nunca escreva senhas nem códigos.',
    '',
    '## Passos',
    '1. Passos curtos e numerados, com localizadores semânticos (papel, texto visível, rótulo, placeholder), nunca coordenadas.',
    '2. Para login: clique no campo e chame `vault_fill`.',
    '3. Para códigos de verificação ou dados sensíveis: use `secure_input`.',
    '',
    '## Confirmar antes de',
    '- Ações sem volta (emitir, enviar, pagar, excluir): pare e peça confirmação antes.',
    '',
    '## Como saber que deu certo',
    '- O que deve aparecer na tela ou no arquivo baixado.',
    '',
    '## Se algo estiver diferente',
    '- Pare e peça ajuda; não tente adivinhar. Diga o que esperava ver.',
    '',
    'Se `teach_submit_draft` devolver um erro, corrija o rascunho e chame de novo.',
    '',
    'Linha do tempo gravada:',
    '',
    timeline,
  ].join('\n');
}

const parseFrontmatter = (block: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z_-]+):\s*(.*?)\s*$/.exec(line);
    if (match) out[match[1].toLowerCase()] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
};

const normalizeHeading = (heading: string): string =>
  heading
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

/** List items under each `## ` heading, keyed by the normalized heading. */
const sections = (body: string): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = [];
      out.set(normalizeHeading(heading[1]), current);
      continue;
    }
    const item = current ? LIST_ITEM_RE.exec(line) : null;
    if (item && current) current.push(item[1]);
  }
  return out;
};

/** Validates a submitted SKILL.md and extracts what the review card shows. */
export function parseDraft(markdown: string): ParsedDraft {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_DRAFT_BYTES) {
    return { ok: false, error: 'o rascunho passa de 64 KB; resuma os passos' };
  }
  const text = markdown.replace(/\r\n/g, '\n');
  const front = FRONTMATTER_RE.exec(text);
  if (!front) return { ok: false, error: 'faltou o frontmatter (--- name/description ---) no início' };
  const meta = parseFrontmatter(front[1]);
  const name = meta.name ?? '';
  if (!TAUGHT_SKILL_NAME_RE.test(name)) {
    return { ok: false, error: 'name deve ser jr-tarefa-<apelido> com 3 a 48 letras minúsculas, números ou hífens' };
  }
  const description = meta.description ?? '';
  if (!description) return { ok: false, error: 'faltou description no frontmatter' };
  const parts = sections(text.slice(front[0].length));
  const steps = parts.get('passos');
  if (!steps) return { ok: false, error: 'faltou a seção ## Passos' };
  if (steps.length === 0) return { ok: false, error: 'a seção ## Passos não tem nenhum passo' };
  return {
    ok: true,
    name,
    description,
    inputs: parts.get('entradas') ?? [],
    logins: (parts.get('logins') ?? []).map((item) => LOGIN_RE.exec(item)?.[1] ?? item),
    steps,
    confirmBefore: parts.get('confirmar antes de') ?? [],
  };
}

/** Replaces the frontmatter `name` (the review card lets the employee rename the task). */
export function withDraftName(markdown: string, name: string): string {
  return markdown.replace(/^(---\r?\n[\s\S]*?^name:)[^\r\n]*/m, `$1 ${name}`);
}
