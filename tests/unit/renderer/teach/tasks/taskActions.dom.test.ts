import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

const { startJrConversation } = vi.hoisted(() => ({ startJrConversation: vi.fn() }));

vi.mock('@renderer/pages/Jr/jrBots', () => ({ startJrConversation }));

import type { JrBot } from '@renderer/pages/Jr/jrBots';
import {
  buildRunPrompt,
  pickRunBot,
  runTaughtTask,
  taughtSkillFromPrompt,
} from '@renderer/pages/Jr/JrSidebar/Teach/taskActions';
import { takeConversationIntent } from '@renderer/pages/conversation/Preview/browser/TeachCards/teachStore';

const t = ((key: string, opts?: Record<string, string>) =>
  opts ? `${key}|${Object.values(opts).join('|')}` : key) as unknown as TFunction;

const bot = (id: string): JrBot => ({ id, name: id, instructions: 'x', workspace: '/w' });
const task = { name: 'jr-tarefa-nfs', description: 'Baixa NFs' };

describe('taughtSkillFromPrompt', () => {
  it('finds the backticked taught skill name', () => {
    expect(taughtSkillFromPrompt('Execute a tarefa salva `jr-tarefa-nfs-mes` agora')).toBe('jr-tarefa-nfs-mes');
  });

  it('returns null for an ordinary prompt', () => {
    expect(taughtSkillFromPrompt('Resumo diário das vendas')).toBeNull();
  });

  it('returns null when the slug is too short for the name rule', () => {
    expect(taughtSkillFromPrompt('`jr-tarefa-ab`')).toBeNull();
  });

  it('returns null when the name is not between backticks', () => {
    expect(taughtSkillFromPrompt('rode jr-tarefa-nfs-mes')).toBeNull();
  });
});

describe('buildRunPrompt', () => {
  it('uses the scheduled prompt with the backticked name', () => {
    const prompt = buildRunPrompt(t, task, 'scheduled');
    expect(prompt.startsWith('common.jr.teach.tasks.scheduledPrompt')).toBe(true);
    expect(prompt).toContain('`jr-tarefa-nfs`');
  });

  it('uses the run prompt with name and description', () => {
    const prompt = buildRunPrompt(t, task, 'now');
    expect(prompt).toBe('common.jr.teach.tasks.runPrompt|`jr-tarefa-nfs`|Baixa NFs');
  });
});

describe('pickRunBot', () => {
  it('prefers the bot open in the sidebar', () => {
    expect(pickRunBot([bot('a'), bot('b')], 'b')?.id).toBe('b');
  });

  it('falls back to the first bot when the active one is missing', () => {
    expect(pickRunBot([bot('a'), bot('b')], 'missing')?.id).toBe('a');
  });

  it('returns null without bots', () => {
    expect(pickRunBot([], null)).toBeNull();
  });
});

describe('runTaughtTask', () => {
  beforeEach(() => {
    sessionStorage.clear();
    startJrConversation.mockReset();
  });
  afterEach(() => {
    takeConversationIntent('c1');
  });

  it('stores the initial message, queues the browser intent and navigates', async () => {
    startJrConversation.mockResolvedValue({ id: 'c1', name: 'Bot' });
    const navigate = vi.fn();
    await runTaughtTask({ bot: bot('b 1'), prompt: 'PROMPT', navigate });
    expect(startJrConversation).toHaveBeenCalledWith(expect.objectContaining({ id: 'b 1' }), {
      newConversation: true,
    });
    expect(JSON.parse(sessionStorage.getItem('aionrs_initial_message_c1') ?? '{}')).toEqual({ input: 'PROMPT' });
    expect(takeConversationIntent('c1')).toEqual({ openBrowser: true });
    expect(navigate).toHaveBeenCalledWith('/conversation/c1?bot=b%201');
  });

  it('rejects and navigates nowhere when startJrConversation fails', async () => {
    startJrConversation.mockRejectedValue(new Error('offline'));
    const navigate = vi.fn();
    await expect(runTaughtTask({ bot: bot('a'), prompt: 'PROMPT', navigate })).rejects.toThrow('offline');
    expect(navigate).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });
});
