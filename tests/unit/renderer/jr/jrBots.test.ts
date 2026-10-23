import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { IProvider } from '@/common/config/storage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  writeRules: vi.fn(),
  skills: vi.fn(),
  readSetting: vi.fn(),
  writeSetting: vi.fn(),
  providers: vi.fn(),
  conversation: vi.fn(),
  getConversation: vi.fn(),
  updateConversation: vi.fn(),
  conversations: vi.fn(),
  mcps: vi.fn(),
  systemInfo: vi.fn(),
  createMcp: vi.fn(),
  toggleMcp: vi.fn(),
  ensure: vi.fn(),
  readProviders: vi.fn(),
  report: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: {
      list: { invoke: mocks.list },
      create: { invoke: mocks.create },
      update: { invoke: mocks.update },
      get: { invoke: mocks.get },
      delete: { invoke: mocks.remove },
    },
    fs: {
      writeAssistantRule: { invoke: mocks.writeRules },
      listAvailableSkills: { invoke: mocks.skills },
    },
    mode: { listProviders: { invoke: mocks.providers } },
    jr: {
      ensureGateway: { invoke: mocks.ensure },
      readProviders: { invoke: mocks.readProviders },
      reportOpenError: { invoke: mocks.report },
    },
    conversation: {
      create: { invoke: mocks.conversation },
      get: { invoke: mocks.getConversation },
      update: { invoke: mocks.updateConversation },
    },
    database: { getUserConversations: { invoke: mocks.conversations } },
    application: { systemInfo: { invoke: mocks.systemInfo } },
    mcpService: {
      listServers: { invoke: mocks.mcps },
      createServer: { invoke: mocks.createMcp },
      toggleServer: { invoke: mocks.toggleMcp },
    },
  },
}));
vi.mock('@/renderer/services/clientBusinessSettings', () => ({
  getClientBusinessSetting: mocks.readSetting,
  setClientBusinessSetting: mocks.writeSetting,
}));

import {
  JR_DEFAULT_INSTRUCTIONS,
  listJrBots,
  reportJrOpenError,
  saveJrBot,
  selectJrModel,
  startJrConversation,
  validateJrBot,
} from '@/renderer/pages/Jr/jrBots';

const runtime = {
  id: 'internal',
  agent_id: 'agent-aionrs',
  source: 'generated',
  agent: { type: 'aionrs' },
} as Assistant;
const input = { name: 'Compras', instructions: 'Ajude com as compras.', workspace: '/tmp/jr-compras' };
const provider = {
  id: 'jr-provider',
  name: 'JR MiniMax',
  platform: 'openai',
  base_url: 'http://127.0.0.1:1234/v1',
  api_key: 'temporary',
  models: ['MiniMax-M3.1-Flash'],
} as IProvider;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([runtime]);
  mocks.create.mockResolvedValue({ id: 'jr-bot', name: input.name, source: 'user', agent: { type: 'aionrs' } });
  mocks.readSetting.mockResolvedValue({});
  mocks.writeSetting.mockResolvedValue(undefined);
  mocks.writeRules.mockResolvedValue(true);
  mocks.skills.mockResolvedValue([]);
  mocks.updateConversation.mockResolvedValue(true);
  mocks.providers.mockResolvedValue([provider]);
  mocks.ensure.mockResolvedValue(undefined);
  mocks.get.mockResolvedValue({ source: 'user', engine: { agent: { type: 'aionrs' } } });
  mocks.readProviders.mockResolvedValue([]);
  mocks.report.mockResolvedValue(undefined);
  mocks.mcps.mockResolvedValue([]);
  mocks.systemInfo.mockResolvedValue({ cacheDir: '/tmp/jr-cache' });
  mocks.createMcp.mockRejectedValue(new Error('chrome-unavailable'));
  mocks.conversations.mockResolvedValue({ items: [], total: 0, has_more: false });
  mocks.getConversation.mockResolvedValue(null);
  mocks.conversation.mockResolvedValue({ id: 'real-conversation' });
});

it('records the open failure without a bearer token', () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const secret = 'b'.repeat(64);
  const message = reportJrOpenError(new Error(`upstream Bearer ${secret}`));
  expect(message).toBe('upstream Bearer [redacted]');
  expect(message).not.toContain(secret);
  expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ message: 'upstream Bearer [redacted]' }));
  errorSpy.mockRestore();
});

describe('JR bot persistence', () => {
  it('keeps confirmations and avoids repeated equivalent tool reads in the default rules', () => {
    expect(JR_DEFAULT_INSTRUCTIONS).toContain('aguarde as confirmações de escrita e execução');
    expect(JR_DEFAULT_INSTRUCTIONS).toContain('sem repetir consultas equivalentes');
    expect(JR_DEFAULT_INSTRUCTIONS).toContain('Verifique cada resultado uma vez');
  });

  it('requires a name, instructions and an absolute workspace before writes', () => {
    expect(validateJrBot({ ...input, name: '  ' })).toBe('name');
    expect(validateJrBot({ ...input, instructions: '' })).toBe('instructions');
    expect(validateJrBot({ ...input, workspace: 'relative/folder' })).toBe('workspace');
    expect(validateJrBot({ ...input, workspace: 'C:\\Projetos\\Compras' })).toBeNull();
    expect(validateJrBot(input)).toBeNull();
  });

  it('persists the real assistant, rules and workspace mapping', async () => {
    const bot = await saveJrBot(input);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Compras', agent_id: 'agent-aionrs' }));
    expect(mocks.writeRules).toHaveBeenCalledWith({
      assistant_id: 'jr-bot',
      locale: 'pt-BR',
      content: input.instructions,
    });
    expect(mocks.writeSetting).toHaveBeenCalledWith('jr.botWorkspaces', {
      'jr-bot': {
        workspace: input.workspace,
        instructions: input.instructions,
        learning: '',
        skillIds: [],
        useChrome: true,
      },
    });
    expect(bot.id).toBe('jr-bot');
  });

  it('refuses to save when the installed skill catalog cannot be read', async () => {
    mocks.skills.mockRejectedValue(new Error('skills-offline'));
    await expect(saveJrBot(input)).rejects.toThrow('skills-offline');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.writeSetting).not.toHaveBeenCalled();
  });

  it('removes a newly created assistant when rules or workspace cannot be saved', async () => {
    mocks.writeSetting.mockRejectedValue(new Error('unavailable'));
    await expect(saveJrBot(input)).rejects.toThrow('unavailable');
    expect(mocks.remove).toHaveBeenCalledWith({ id: 'jr-bot' });
  });

  it('rejects a false rule-write acknowledgement', async () => {
    mocks.writeRules.mockResolvedValue(false);
    await expect(saveJrBot(input)).rejects.toThrow();
    expect(mocks.remove).toHaveBeenCalledWith({ id: 'jr-bot' });
    expect(mocks.writeSetting).not.toHaveBeenCalled();
  });

  it('lists only configured user bots with the embedded runtime', async () => {
    mocks.list.mockResolvedValue([
      runtime,
      { id: 'ours', name: 'Nosso bot', source: 'user', agent: { type: 'aionrs' } },
      { id: 'other', source: 'builtin', agent: { type: 'aionrs' } },
      { id: 'cli', source: 'user', agent: { type: 'acp' } },
    ]);
    mocks.readSetting.mockResolvedValue({
      ours: { workspace: '/tmp/ours' },
      other: { workspace: '/tmp/other' },
      cli: { workspace: '/tmp/cli' },
    });
    expect((await listJrBots()).map((bot) => bot.id)).toEqual(['ours']);
  });

  it('drops a bot whose name is only a raw id', async () => {
    const orphanId = 'aa67fc9c-923b-48d2-8c7a-7ec88aecdb11';
    mocks.list.mockResolvedValue([
      runtime,
      { id: orphanId, name: orphanId, source: 'user', agent: { type: 'aionrs' } },
      { id: 'ours', name: 'Nosso bot', source: 'user', agent: { type: 'aionrs' } },
    ]);
    mocks.readSetting.mockResolvedValue({
      [orphanId]: { workspace: `/tmp/jr-workspaces/${orphanId}` },
      ours: { workspace: '/tmp/ours' },
    });
    expect((await listJrBots()).map((bot) => bot.name)).toEqual(['Nosso bot']);
  });

  it('never falls back to another provider and strips credentials from the model selection', () => {
    expect(selectJrModel([{ ...provider, name: 'Other' }])).toBeNull();
    expect(selectJrModel([{ ...provider, models: ['Other'] }])).toBeNull();
    expect(selectJrModel([{ ...provider, enabled: false }])).toBeNull();
    expect(selectJrModel([provider])).toEqual(
      expect.objectContaining({ id: 'jr-provider', use_model: 'MiniMax-M3.1-Flash', api_key: '' })
    );
    expect(
      selectJrModel([{ ...provider, models: [{ id: 'MiniMax-M3.1-Flash' }] as unknown as string[] }])?.use_model
    ).toBe('MiniMax-M3.1-Flash');
    expect(selectJrModel([{ ...provider, models: '["MiniMax-M3.1-Flash"]' as unknown as string[] }])?.use_model).toBe(
      'MiniMax-M3.1-Flash'
    );
    expect(selectJrModel([{ ...provider, enabled: 0 as unknown as boolean }])).toBeNull();
  });

  it('opens the conversation when gateway registration fails but the provider is already listed', async () => {
    mocks.ensure.mockRejectedValue(new Error('gateway down'));
    const result = await startJrConversation({ id: 'jr-bot', ...input });
    expect(result.id).toBe('real-conversation');
    expect(mocks.readProviders).not.toHaveBeenCalled();
  });

  it('reads the loopback provider list when the session list omits JR MiniMax', async () => {
    mocks.providers.mockResolvedValue([]);
    mocks.readProviders.mockResolvedValue([provider]);
    await startJrConversation({ id: 'jr-bot', ...input });
    expect(mocks.conversation).toHaveBeenCalledWith(expect.objectContaining({ name: input.name }));
  });

  it('retries conversation creation once when the assistant row is missing', async () => {
    mocks.conversation
      .mockRejectedValueOnce(new Error('TEAM_ASSISTANT_NOT_FOUND'))
      .mockResolvedValueOnce({ id: 'real-conversation' });
    await startJrConversation({ id: 'jr-bot', ...input });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'jr-bot' }));
    expect(mocks.conversation).toHaveBeenCalledTimes(2);
  });

  it('recreates a missing assistant and then opens the conversation', async () => {
    mocks.get.mockRejectedValue(new Error('ASSISTANT_NOT_FOUND'));
    await startJrConversation({ id: 'jr-bot', ...input });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'jr-bot', name: input.name }));
    expect(mocks.conversation).toHaveBeenCalled();
  });

  it('reports a missing embedded agent instead of the company-connection banner text', async () => {
    mocks.get.mockRejectedValue(new Error('missing'));
    mocks.list.mockResolvedValue([]);
    await expect(startJrConversation({ id: 'jr-bot', ...input })).rejects.toThrow('Embedded agent is unavailable');
  });

  it('registers the company gateway before reading providers for a new conversation', async () => {
    const order: string[] = [];
    mocks.ensure.mockImplementation(async () => {
      order.push('ensure');
    });
    mocks.providers.mockImplementation(async () => {
      order.push('providers');
      return [provider];
    });
    await startJrConversation({ id: 'jr-bot', ...input });
    expect(order).toEqual(['ensure', 'providers']);
  });

  it('starts a real aionrs conversation in the chosen bot workspace', async () => {
    const result = await startJrConversation({ id: 'jr-bot', ...input });
    expect(mocks.conversation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: input.name,
        assistant: expect.objectContaining({ id: 'jr-bot', locale: 'pt-BR' }),
        model: expect.objectContaining({ id: 'jr-provider', use_model: 'MiniMax-M3.1-Flash' }),
        extra: expect.objectContaining({ workspace: input.workspace, custom_workspace: true }),
      })
    );
    expect(result.id).toBe('real-conversation');
  });
});

it('enables Chrome by default and attaches it to the new conversation', async () => {
  const created = {
    id: 'chrome-jr-1',
    name: 'chrome-jr',
    enabled: true,
    builtin: false,
    transport: { type: 'stdio', command: 'npx', args: ['chrome-devtools-mcp@1.12.0'] },
  };
  mocks.createMcp.mockResolvedValue(created);
  mocks.mcps.mockResolvedValueOnce([]).mockResolvedValue([created]);
  await startJrConversation({ id: 'jr-bot', ...input });
  expect(mocks.createMcp).toHaveBeenCalled();
  expect(mocks.conversation).toHaveBeenCalledWith(
    expect.objectContaining({
      assistant: expect.objectContaining({
        conversation_overrides: expect.objectContaining({ mcp_ids: ['chrome-jr-1'] }),
      }),
    })
  );
});

it('attaches Chrome and every installed skill when the saved bot tried to turn them off', async () => {
  const created = {
    id: 'chrome-jr-1',
    name: 'chrome-jr',
    enabled: true,
    builtin: false,
    transport: { type: 'stdio', command: 'npx', args: [] },
  };
  mocks.skills.mockResolvedValue([{ name: 'planilhas' }]);
  mocks.createMcp.mockResolvedValue(created);
  mocks.mcps.mockResolvedValueOnce([]).mockResolvedValue([created]);
  await startJrConversation({ id: 'jr-bot', ...input, skillIds: [], useChrome: false });
  expect(mocks.conversation).toHaveBeenCalledWith(
    expect.objectContaining({
      assistant: expect.objectContaining({
        conversation_overrides: { skill_ids: ['planilhas'], mcp_ids: ['chrome-jr-1'] },
      }),
    })
  );
});

it('passes enabled MCP connections into the actual embedded-agent conversation', async () => {
  const chrome = {
    id: 'chrome-1',
    name: 'Chrome',
    enabled: true,
    transport: { type: 'stdio', command: 'npx', args: ['chrome-devtools-mcp@1.12.0'] },
  };
  mocks.mcps.mockResolvedValue([chrome, { ...chrome, id: 'disabled', enabled: false }]);
  await startJrConversation({ id: 'jr-bot', ...input });
  expect(mocks.conversation).toHaveBeenCalledWith(
    expect.objectContaining({
      assistant: expect.objectContaining({ conversation_overrides: { skill_ids: [], mcp_ids: ['chrome-1'] } }),
      extra: expect.objectContaining({
        selected_mcp_server_ids: ['chrome-1'],
        selected_session_mcp_servers: [{ id: chrome.id, name: chrome.name, transport: chrome.transport }],
      }),
    })
  );
});

it('keeps animated appearance outside the native emoji or local-file avatar contract', async () => {
  mocks.create.mockImplementation(async (payload: { avatar?: string }) => {
    if (payload.avatar?.startsWith('data:')) throw new Error('assistant avatar must be an emoji or a local image file');
    return { id: 'jr-bot' };
  });
  const bot = await saveJrBot({ ...input, appearance: { shape: 'star', color: 'blue' } });
  expect(bot.appearance).toEqual({ shape: 'star', color: 'blue' });
  expect(mocks.writeSetting).toHaveBeenCalledWith('jr.botWorkspaces', {
    'jr-bot': {
      workspace: input.workspace,
      instructions: input.instructions,
      learning: '',
      skillIds: [],
      useChrome: true,
      appearance: { shape: 'star', color: 'blue' },
    },
  });
});

it('restores the previous bot name and instructions when editing its workspace fails', async () => {
  mocks.readSetting.mockResolvedValue({
    'jr-bot': { workspace: input.workspace, appearance: { shape: 'heart', color: 'red' } },
  });
  mocks.get.mockResolvedValue({
    source: 'user',
    profile: { name: 'Anterior' },
    rules: { content: 'Regras anteriores' },
    engine: { agent: { type: 'aionrs' } },
  });
  mocks.writeSetting.mockRejectedValue(new Error('failed-setting'));
  await expect(saveJrBot({ ...input, appearance: { shape: 'star', color: 'blue' } }, 'jr-bot')).rejects.toThrow(
    'failed-setting'
  );
  expect(mocks.writeRules).toHaveBeenLastCalledWith({
    assistant_id: 'jr-bot',
    locale: 'pt-BR',
    content: 'Regras anteriores',
  });
  expect(mocks.update).toHaveBeenLastCalledWith({
    id: 'jr-bot',
    name: 'Anterior',
    defaults: { skills: { mode: 'fixed', value: [] } },
  });
  expect(mocks.remove).not.toHaveBeenCalled();
});

it('does not attach pending official Gmail connections to a new model conversation', async () => {
  mocks.mcps.mockResolvedValue([
    {
      id: 'gmail',
      name: 'Gmail',
      enabled: true,
      transport: { type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
    },
  ]);
  await startJrConversation({ id: 'jr-bot', ...input });
  expect(mocks.conversation).toHaveBeenCalledWith(
    expect.objectContaining({
      assistant: expect.objectContaining({ conversation_overrides: { skill_ids: [], mcp_ids: [] } }),
    })
  );
});

describe('one persistent conversation per JR bot', () => {
  const bot = { id: 'jr-bot', ...input };
  const conversation = {
    id: 'existing-chat',
    type: 'aionrs',
    assistant: { id: bot.id },
    extra: { workspace: input.workspace },
    modified_at: 20,
  };

  it('reopens the bound conversation without starting a parallel chat', async () => {
    mocks.readSetting.mockResolvedValue({ [bot.id]: { workspace: bot.workspace, conversationId: conversation.id } });
    mocks.getConversation.mockResolvedValue(conversation);
    expect(await startJrConversation(bot)).toEqual(conversation);
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.conversations).not.toHaveBeenCalled();
    expect(mocks.updateConversation).not.toHaveBeenCalled();
  });

  it('patches a bound conversation that is missing skills or Chrome', async () => {
    const chrome = {
      id: 'chrome-jr-1',
      name: 'chrome-jr',
      enabled: true,
      builtin: false,
      transport: { type: 'stdio', command: 'npx', args: [] },
    };
    mocks.skills.mockResolvedValue([{ name: 'planilhas' }]);
    mocks.mcps.mockResolvedValue([chrome]);
    const existing = {
      ...conversation,
      extra: { workspace: input.workspace, skills: [] as string[], mcp_server_ids: [] as string[] },
    };
    mocks.readSetting.mockResolvedValue({ [bot.id]: { workspace: bot.workspace, conversationId: existing.id } });
    mocks.getConversation.mockResolvedValue(existing);
    await startJrConversation({ ...bot, skillIds: [], useChrome: false });
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.updateConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: existing.id,
        merge_extra: true,
        updates: expect.objectContaining({
          extra: expect.objectContaining({
            skills: ['planilhas'],
            mcp_server_ids: ['chrome-jr-1'],
          }),
        }),
      })
    );
  });

  it('adopts the most recent matching history and preserves its messages', async () => {
    mocks.conversations.mockResolvedValue({
      items: [
        { id: 'unrelated-chat', type: 'acp', modified_at: 40 },
        { ...conversation, id: 'other-bot', assistant: { id: 'someone-else' }, modified_at: 30 },
        { ...conversation, id: 'older-chat', modified_at: 10 },
        conversation,
      ],
      total: 4,
      has_more: false,
    });
    expect(await startJrConversation(bot)).toEqual(conversation);
    expect(mocks.writeSetting).toHaveBeenCalledWith(
      'jr.botWorkspaces',
      expect.objectContaining({
        [bot.id]: expect.objectContaining({ conversationId: conversation.id }),
      })
    );
    expect(mocks.conversation).not.toHaveBeenCalled();
  });

  it('recognizes the same workspace across macOS Unicode normalization forms', async () => {
    const workspace = '/tmp/Comprás';
    mocks.readSetting.mockResolvedValue({
      [bot.id]: { workspace: workspace.normalize('NFD'), conversationId: conversation.id },
    });
    mocks.getConversation.mockResolvedValue({ ...conversation, extra: { workspace: workspace.normalize('NFC') } });
    expect((await startJrConversation({ ...bot, workspace: workspace.normalize('NFD') })).id).toBe(conversation.id);
    expect(mocks.conversation).not.toHaveBeenCalled();
  });

  it('creates only one conversation for overlapping opens of the same bot', async () => {
    const [a, b] = await Promise.all([startJrConversation(bot), startJrConversation(bot)]);
    expect(a.id).toBe(b.id);
    expect(mocks.conversation).toHaveBeenCalledTimes(1);
    expect(mocks.writeSetting).toHaveBeenCalledWith(
      'jr.botWorkspaces',
      expect.objectContaining({
        [bot.id]: expect.objectContaining({ conversationId: 'real-conversation' }),
      })
    );
  });

  it('does not reuse another bot conversation from an invalid local binding', async () => {
    mocks.readSetting.mockResolvedValue({ [bot.id]: { workspace: bot.workspace, conversationId: 'foreign' } });
    mocks.getConversation.mockResolvedValue({ ...conversation, id: 'foreign', assistant: { id: 'another-bot' } });
    expect((await startJrConversation(bot)).id).toBe('real-conversation');
    expect(mocks.conversation).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the existing conversation cannot be checked', async () => {
    mocks.readSetting.mockResolvedValue({ [bot.id]: { workspace: bot.workspace, conversationId: conversation.id } });
    mocks.getConversation.mockRejectedValue(new Error('offline'));
    await expect(startJrConversation(bot)).rejects.toThrow('offline');
    expect(mocks.conversation).not.toHaveBeenCalled();
  });

  it('does not create a duplicate when the historical listing is incomplete', async () => {
    mocks.conversations.mockResolvedValue({ items: [], total: 10001, has_more: true });
    await expect(startJrConversation(bot)).rejects.toThrow();
    expect(mocks.conversation).not.toHaveBeenCalled();
  });

  it('preserves the conversation binding while editing the bot appearance', async () => {
    mocks.readSetting.mockResolvedValue({ [bot.id]: { workspace: bot.workspace, conversationId: conversation.id } });
    mocks.get.mockResolvedValue({
      source: 'user',
      profile: { name: bot.name },
      rules: { content: bot.instructions },
      engine: { agent: { type: 'aionrs' } },
    });
    await saveJrBot({ ...input, appearance: { shape: 'star', color: 'blue' } }, bot.id);
    expect(mocks.writeSetting).toHaveBeenCalledWith(
      'jr.botWorkspaces',
      expect.objectContaining({
        [bot.id]: expect.objectContaining({ conversationId: conversation.id }),
      })
    );
  });

  it('stores learning with every installed skill, ignoring a shorter skill list', async () => {
    mocks.skills.mockResolvedValue([{ name: 'pesquisa-jr' }, { name: 'planilhas' }]);
    const trained = {
      ...input,
      learning: 'Conferir o relatório antes de concluir.',
      skillIds: ['planilhas'],
      useChrome: false,
    };
    await saveJrBot(trained);
    expect(mocks.writeRules).toHaveBeenCalledWith(
      expect.objectContaining({
        content: `${input.instructions}\n\n## Aprendizados deste bot\n${trained.learning}`,
      })
    );
    expect(mocks.writeSetting).toHaveBeenCalledWith(
      'jr.botWorkspaces',
      expect.objectContaining({
        'jr-bot': expect.objectContaining({
          learning: trained.learning,
          skillIds: ['pesquisa-jr', 'planilhas'],
          useChrome: true,
        }),
      })
    );
    await startJrConversation({ id: 'jr-bot', ...trained });
    expect(mocks.conversation).toHaveBeenCalledWith(
      expect.objectContaining({
        assistant: expect.objectContaining({
          conversation_overrides: expect.objectContaining({ skill_ids: ['pesquisa-jr', 'planilhas'] }),
        }),
      })
    );
  });

  it('rewrites a loaded bot that had dropped skills or Chrome', async () => {
    mocks.skills.mockResolvedValue([{ name: 'pesquisa-jr' }, { name: 'planilhas' }]);
    mocks.list.mockResolvedValue([
      runtime,
      { id: 'ours', name: 'Nosso bot', source: 'user', agent: { type: 'aionrs' } },
    ]);
    mocks.readSetting.mockResolvedValue({
      ours: { workspace: '/tmp/ours', skillIds: ['planilhas'], useChrome: false },
    });
    const [bot] = await listJrBots();
    expect(bot).toMatchObject({ id: 'ours', skillIds: ['pesquisa-jr', 'planilhas'], useChrome: true });
    expect(mocks.update).toHaveBeenCalledWith({
      id: 'ours',
      defaults: { skills: { mode: 'fixed', value: ['pesquisa-jr', 'planilhas'] } },
    });
    expect(mocks.writeSetting).toHaveBeenCalledWith(
      'jr.botWorkspaces',
      expect.objectContaining({
        ours: expect.objectContaining({ skillIds: ['pesquisa-jr', 'planilhas'], useChrome: true }),
      })
    );
  });
});
