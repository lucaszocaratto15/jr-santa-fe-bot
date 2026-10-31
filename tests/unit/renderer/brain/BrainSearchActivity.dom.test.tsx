import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { IMessageToolCall } from '@/common/chat/chatLib';
import MessageToolGroupSummary from '@renderer/pages/conversation/Messages/components/MessageToolGroupSummary';
import BrainSearchActivity from '@renderer/pages/conversation/Messages/components/BrainSearchActivity/BrainSearchActivity';
import {
  isBrainSearchTool,
  mergeBrainSearchCalls,
  parseBrainSearchOutput,
} from '@renderer/pages/conversation/Messages/components/BrainSearchActivity/parseBrainSearch';
import { brainRowsPerReply } from '@renderer/pages/conversation/Messages/components/BrainSearchActivity/brainRows';
import { localeNames, ptBR, readCommon, withI18n } from '../teach/learn/i18nTestUtils';

vi.mock('@/renderer/components/media/LocalImageView', () => ({ __esModule: true, default: () => null }));

const i18n = ptBR();
const FACTS = [
  '- [2026-10-01 · confiança 8] Fornecedor de cimento em Jales entrega em 3 dias (compras) {id: 11}',
  '- [2026-09-20 · confiança 6] Obra de Jales usa betoneira própria (obras) {id: 12}',
  '- [2026-08-02 · confiança 5] Contato do almoxarifado muda às sextas (almoxarifado) {id: 13}',
].join('\n');

const setReducedMotion = (reduced: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
};

const activity = (status: 'pending' | 'running' | 'completed' | 'error', output?: string) =>
  render(withI18n(i18n, <BrainSearchActivity status={status} output={output} />));

describe('BrainSearchActivity', () => {
  beforeEach(() => setReducedMotion(false));
  afterEach(() => vi.restoreAllMocks());

  it('animates the brain and says it is consulting while the call is pending', () => {
    activity('running');
    const root = screen.getByTestId('brain-search-activity');
    expect(root.className).toMatch(/animated/);
    expect(root.querySelector('svg')).not.toBeNull();
    expect(root.querySelectorAll('circle').length).toBeGreaterThan(20);
    expect(screen.getByRole('status').textContent).toBe('Consultando o cérebro da empresa…');
  });

  it('stops on the formed brain and counts the result lines when finished', () => {
    activity('completed', FACTS);
    const root = screen.getByTestId('brain-search-activity');
    expect(root.className).not.toMatch(/animated/);
    expect(screen.getByRole('status').textContent).toBe('Consultou o cérebro da empresa · 3 fatos');
    expect(root.textContent).not.toMatch(/cimento|betoneira|almoxarifado|\{id/);
  });

  it('says nothing found for the empty result and unavailable for the unavailable text', () => {
    const { unmount } = activity('completed', 'O cérebro não tem nada sobre isso.');
    expect(screen.getByRole('status').textContent).toBe('Consultou o cérebro da empresa · nada encontrado');
    unmount();
    activity('completed', 'Cérebro indisponível agora; siga sem ele.');
    expect(screen.getByRole('status').textContent).toBe('Cérebro indisponível');
  });

  it('uses the singular for one fact', () => {
    activity('completed', FACTS.split('\n')[0]);
    expect(screen.getByRole('status').textContent).toBe('Consultou o cérebro da empresa · 1 fato');
  });

  it('shows unavailable when the call errored', () => {
    activity('error', '');
    expect(screen.getByRole('status').textContent).toBe('Cérebro indisponível');
  });

  it('keeps the drawing static under prefers-reduced-motion', () => {
    setReducedMotion(true);
    activity('running');
    expect(screen.getByTestId('brain-search-activity').className).not.toMatch(/animated/);
    expect(screen.getByRole('status').textContent).toBe('Consultando o cérebro da empresa…');
  });
});

describe('brain_search result parsing', () => {
  it('recognises the tool by bare or server-prefixed name only', () => {
    expect(isBrainSearchTool('brain_search')).toBe(true);
    expect(isBrainSearchTool('mcp__jr-teach__brain_search')).toBe(true);
    expect(isBrainSearchTool('jr-teach:brain_search')).toBe(true);
    expect(isBrainSearchTool('brain_wrong')).toBe(false);
    expect(isBrainSearchTool('web_brain_search')).toBe(false);
  });

  it('counts fact lines only', () => {
    expect(parseBrainSearchOutput(FACTS)).toEqual({ kind: 'found', count: 3 });
    expect(parseBrainSearchOutput(undefined)).toEqual({ kind: 'found', count: 0 });
  });
});

describe('MessageToolGroupSummary dispatch', () => {
  const call = (name: string, status: 'running' | 'completed', output?: string): IMessageToolCall => ({
    id: `m-${name}`,
    conversation_id: 'c1',
    type: 'tool_call',
    content: { call_id: `call-${name}`, name, args: { query: 'cimento' }, status, output },
  });
  const mount = (messages: IMessageToolCall[]) =>
    render(withI18n(i18n, <MessageToolGroupSummary messages={messages} />));

  beforeEach(() => setReducedMotion(false));

  it('renders the animation for a pending brain_search instead of the generic live line', () => {
    mount([call('mcp__jr-teach__brain_search', 'running')]);
    expect(screen.getByTestId('brain-search-activity')).toBeTruthy();
    expect(screen.queryByTestId('tool-group-live-step')).toBeNull();
  });

  it('keeps the generic details reachable for a finished brain_search', () => {
    const { container } = mount([call('mcp__jr-teach__brain_search', 'completed', FACTS)]);
    expect(screen.getByRole('status').textContent).toBe('Consultou o cérebro da empresa · 3 fatos');
    fireEvent.click(container.querySelector('.tool-group-summary__header') as HTMLElement);
    expect(screen.getByText(/brain_search/)).toBeTruthy();
  });

  it('shows one animation for several brain_search calls and counts all their facts', () => {
    const lines = FACTS.split('\n');
    mount([
      { ...call('brain_search', 'completed', lines[0]), id: 'm-a' },
      { ...call('brain_search', 'completed', lines.slice(1).join('\n')), id: 'm-b' },
    ]);
    expect(screen.getAllByTestId('brain-search-activity')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Consultou o cérebro da empresa · 3 fatos');
  });

  it('draws no animation when the reply already showed it on an earlier row', () => {
    render(
      withI18n(i18n, <MessageToolGroupSummary messages={[call('brain_search', 'completed', FACTS)]} brainMessages={null} />)
    );
    expect(screen.queryByTestId('brain-search-activity')).toBeNull();
  });

  it('leaves other tool calls on the generic row', () => {
    mount([call('Read', 'running')]);
    expect(screen.queryByTestId('brain-search-activity')).toBeNull();
    expect(screen.getByTestId('tool-group-live-step')).toBeTruthy();
  });
});

describe('one brain animation per reply', () => {
  const tool = (id: string, name: string): IMessageToolCall => ({
    id,
    conversation_id: 'c1',
    type: 'tool_call',
    content: { call_id: `call-${id}`, name, args: {}, status: 'completed', output: '' },
  });
  const summary = (id: string, ...messages: IMessageToolCall[]) => ({ type: 'tool_summary', id, messages });

  it('gives the first brain row of a reply every call of that reply and null to later rows', () => {
    const rows = brainRowsPerReply([
      { type: 'text', position: 'right' },
      summary('s1', tool('a', 'Read')),
      summary('s2', tool('b', 'brain_search')),
      { type: 'text', position: 'left' },
      summary('s3', tool('c', 'mcp__jr-teach__brain_search'), tool('d', 'Grep')),
      { type: 'text', position: 'right' },
      summary('s4', tool('e', 'brain_search')),
    ]);
    expect(rows.has('s1')).toBe(false);
    expect(rows.get('s2')?.map((message) => message.id)).toEqual(['b', 'c']);
    expect(rows.get('s3')).toBeNull();
    expect(rows.get('s4')?.map((message) => message.id)).toEqual(['e']);
  });

  it('stays running while any call runs and reports unavailable only when none answered', () => {
    expect(mergeBrainSearchCalls([{ status: 'completed', output: FACTS }, { status: 'running' }]).status).toBe(
      'running'
    );
    const unavailable = 'Cérebro indisponível agora.';
    expect(
      parseBrainSearchOutput(
        mergeBrainSearchCalls([
          { status: 'completed', output: unavailable },
          { status: 'completed', output: FACTS },
        ]).output
      )
    ).toEqual({ kind: 'found', count: 3 });
    expect(parseBrainSearchOutput(mergeBrainSearchCalls([{ status: 'completed', output: unavailable }]).output)).toEqual(
      { kind: 'unavailable' }
    );
  });
});

describe('locales', () => {
  it('has the activity keys in every locale', () => {
    for (const lang of localeNames()) {
      const jr = readCommon(lang).jr as { brain?: { activity?: Record<string, string> } };
      const a = jr.brain?.activity ?? {};
      for (const key of ['running', 'doneOne', 'done', 'doneNone', 'unavailable']) {
        expect(a[key], `${lang} ${key}`).toBeTruthy();
      }
      expect(a.done).toContain('{{count}}');
    }
  });
});
