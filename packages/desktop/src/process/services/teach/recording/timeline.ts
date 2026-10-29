/**
 * Turns recorded browser events into a short numbered Portuguese timeline that the AI
 * reads to write a skill. Pure: no I/O. Secret values arrive already masked.
 */

import type { Locator, TeachEvent } from './recorder';

const MAX_TEXT = 80;
const ROLE_WORDS: Record<string, string> = {
  button: 'botão',
  link: 'link',
  textbox: 'campo',
  searchbox: 'campo',
  combobox: 'lista',
  checkbox: 'caixa de seleção',
  radio: 'opção',
  tab: 'aba',
  menuitem: 'item de menu',
  option: 'opção',
  switch: 'chave',
};

type Best = { key: string; text: string; word?: string };

function clean(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
}

function bestOf(loc: Locator): Best | undefined {
  if (loc.role && loc.name) {
    return { key: `role:${loc.role}:${loc.name}`, text: clean(loc.name), word: ROLE_WORDS[loc.role] ?? loc.role };
  }
  const order = ['label', 'text', 'placeholder', 'attr', 'css'] as const;
  for (const field of order) {
    const v = loc[field];
    if (v) return { key: `${field}:${v}`, text: clean(v) };
  }
  return undefined;
}

function best(target?: Locator[]): Best | undefined {
  for (const loc of target ?? []) {
    const b = bestOf(loc);
    if (b) return b;
  }
  return undefined;
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function describe(b: Best | undefined, fallbackWord: string): string {
  if (!b) return fallbackWord;
  return `${b.word ?? fallbackWord} "${b.text}"`;
}

function ctx(e: TeachEvent): string {
  return `(aba ${e.tab}, ${host(e.url)})`;
}

function sameElement(a: TeachEvent, b: TeachEvent): boolean {
  const ka = best(a.target)?.key;
  return ka !== undefined && a.tab === b.tab && ka === best(b.target)?.key;
}

function line(e: TeachEvent): string {
  switch (e.kind) {
    case 'navigate':
      return `Navegou para ${e.url} (aba ${e.tab})`;
    case 'tab-open':
      return `Abriu nova aba: ${e.url}`;
    case 'tab-switch':
      return `Trocou para a aba ${e.tab} (${host(e.url)})`;
    case 'click':
      return `Clicou em ${describe(best(e.target), 'elemento')} ${ctx(e)}`;
    case 'input': {
      const value = clean(e.value ?? '');
      const field = describe(best(e.target), 'campo');
      return value ? `Preencheu ${field} com ${value}` : `Preencheu ${field}`;
    }
    case 'submit':
      return `Enviou o formulário ${describe(best(e.target), '').trim()} ${ctx(e)}`.replace('  ', ' ');
    case 'key':
      return `Pressionou a tecla ${e.key ?? ''} ${ctx(e)}`;
    case 'download':
      return `Baixou arquivo ${e.fileName ?? ''}`.trimEnd();
  }
}

export function summarizeEvents(events: TeachEvent[]): string {
  const kept: TeachEvent[] = [];
  events.forEach((e, i) => {
    const next = events[i + 1];
    if (e.kind === 'click' && next?.kind === 'input' && sameElement(e, next)) return;
    const prev = kept[kept.length - 1];
    if (e.kind === 'input' && prev?.kind === 'input' && sameElement(prev, e)) {
      kept[kept.length - 1] = e;
      return;
    }
    kept.push(e);
  });
  return kept.map((e, i) => `${i + 1}. ${line(e)}`).join('\n');
}
