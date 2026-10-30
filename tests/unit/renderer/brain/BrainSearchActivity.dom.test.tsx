import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { IMessageToolCall } from '@/common/chat/chatLib';
import MessageToolGroupSummary from '@renderer/pages/conversation/Messages/components/MessageToolGroupSummary';
import BrainSearchActivity from '@renderer/pages/conversation/Messages/components/BrainSearchActivity/BrainSearchActivity';
import {
  isBrainSearchTool,
  parseBrainSearchOutput,
} from '@renderer/pages/conversation/Messages/components/BrainSearchActivity/parseBrainSearch';
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

  it('leaves other tool calls on the generic row', () => {
    mount([call('Read', 'running')]);
    expect(screen.queryByTestId('brain-search-activity')).toBeNull();
    expect(screen.getByTestId('tool-group-live-step')).toBeTruthy();
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
