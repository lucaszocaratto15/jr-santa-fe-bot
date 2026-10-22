import { ipcBridge } from '@/common';
import type { IProvider, TChatConversation, TProviderWithModel } from '@/common/config/storage';
import { isAionrsAssistant } from '@/common/types/agent/assistantTypes';
import { getClientBusinessSetting, setClientBusinessSetting } from '@/renderer/services/clientBusinessSettings';
import type { JrAppearance } from '@/common/config/clientSettings';
import { normalizeAppearance } from './botAppearance';
import { isGmailServer } from './Connections/connections';
import { toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';

export const JR_MODEL = 'MiniMax-M3.1-Flash';
export const JR_PROVIDER = 'JR MiniMax';

export const JR_DEFAULT_INSTRUCTIONS =
  'Responda sempre em português do Brasil, inclusive nas mensagens de andamento. Seja claro e breve. Ajude nas tarefas de escritório e projetos desta pasta. Use as ferramentas necessárias e aguarde as confirmações de escrita e execução. Reaproveite resultados já obtidos. Se um campo não existir, informe a ausência sem repetir consultas equivalentes. Verifique cada resultado uma vez e conclua quando o pedido estiver atendido. Não apresente raciocínio interno como resposta.';
export type JrBotInput = { name: string; instructions: string; workspace: string; appearance?: JrAppearance };
export type JrBot = JrBotInput & { id: string };

export function validateJrBot(input: JrBotInput): 'name' | 'instructions' | 'workspace' | null {
  if (!input.name.trim() || input.name.trim().length > 80) return 'name';
  if (!input.instructions.trim() || input.instructions.length > 12000) return 'instructions';
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(input.workspace)) return 'workspace';
  return null;
}

export async function listJrBots(): Promise<JrBot[]> {
  const [assistants, workspaces] = await Promise.all([
    ipcBridge.assistants.list.invoke(),
    getClientBusinessSetting('jr.botWorkspaces'),
  ]);
  return assistants
    .filter((assistant) => assistant.source === 'user' && isAionrsAssistant(assistant) && workspaces?.[assistant.id])
    .map((assistant) => ({
      id: assistant.id,
      name: assistant.name,
      instructions: assistant.context || '',
      workspace: workspaces![assistant.id].workspace,
      appearance: normalizeAppearance(workspaces![assistant.id].appearance),
    }));
}

export async function getJrBot(id: string): Promise<JrBot> {
  const [detail, workspaces] = await Promise.all([
    ipcBridge.assistants.get.invoke({ id, locale: 'pt-BR' }),
    getClientBusinessSetting('jr.botWorkspaces'),
  ]);
  if (detail.source !== 'user' || detail.engine.agent?.type !== 'aionrs' || !workspaces?.[id]) {
    throw new Error('JR bot not found');
  }
  return {
    id,
    name: detail.profile.name,
    instructions: detail.rules.content,
    workspace: workspaces[id].workspace,
    appearance: normalizeAppearance(workspaces[id].appearance),
  };
}

export async function saveJrBot(input: JrBotInput, id?: string): Promise<JrBot> {
  const invalid = validateJrBot(input);
  if (invalid) throw new Error(`Invalid bot ${invalid}`);
  const name = input.name.trim();
  const workspaces = (await getClientBusinessSetting('jr.botWorkspaces')) || {};
  const previous = id ? await getJrBot(id) : null;
  if (!id) {
    const assistants = await ipcBridge.assistants.list.invoke();
    const runtime = assistants.find(isAionrsAssistant);
    if (!runtime) throw new Error('Embedded agent is unavailable');
    const created = await ipcBridge.assistants.create.invoke({
      name,
      agent_id: runtime.agent_id,
      avatar: '🤖',
    });
    id = created.id;
  }
  try {
    const written = await ipcBridge.fs.writeAssistantRule.invoke({
      assistant_id: id,
      locale: 'pt-BR',
      content: input.instructions,
    });
    if (!written) throw new Error('Bot instructions were not saved');
    if (previous)
      await ipcBridge.assistants.update.invoke({
        id,
        name,
        avatar: '🤖',
      });
    await setClientBusinessSetting('jr.botWorkspaces', {
      ...workspaces,
      [id]: {
        ...workspaces[id],
        workspace: input.workspace,
        ...(input.appearance ? { appearance: normalizeAppearance(input.appearance) } : {}),
      },
    });
    return { ...input, name, id };
  } catch (error) {
    if (!previous) {
      await ipcBridge.assistants.delete.invoke({ id });
    } else {
      await ipcBridge.fs.writeAssistantRule.invoke({
        assistant_id: id,
        locale: 'pt-BR',
        content: previous.instructions,
      });
      await ipcBridge.assistants.update.invoke({
        id,
        name: previous.name,
      });
    }
    throw error;
  }
}

export async function deleteJrBot(id: string): Promise<void> {
  await getJrBot(id);
  await ipcBridge.assistants.delete.invoke({ id });
  const workspaces = { ...(await getClientBusinessSetting('jr.botWorkspaces')) };
  delete workspaces[id];
  await setClientBusinessSetting('jr.botWorkspaces', workspaces);
}

export function selectJrModel(providers: IProvider[]): TProviderWithModel | null {
  const provider = providers.find(
    (item) => item.name === JR_PROVIDER && item.enabled !== false && item.models.includes(JR_MODEL)
  );
  return provider ? { ...provider, api_key: '', use_model: JR_MODEL } : null;
}

const openingConversations = new Map<string, Promise<TChatConversation>>();
let conversationQueue: Promise<unknown> = Promise.resolve();

/** Open the bot's durable conversation, coalescing concurrent navigation requests. */
export function startJrConversation(bot: JrBot): Promise<TChatConversation> {
  const pending = openingConversations.get(bot.id);
  if (pending) return pending;
  // Serialize whole-map writes so opening different bots cannot discard each other's bindings.
  const operation = conversationQueue.then(() => resolveJrConversation(bot));
  conversationQueue = operation.catch((): undefined => undefined);
  openingConversations.set(bot.id, operation);
  void operation.then(
    () => openingConversations.delete(bot.id),
    () => openingConversations.delete(bot.id)
  );
  return operation;
}

async function resolveJrConversation(bot: JrBot): Promise<TChatConversation> {
  if (validateJrBot(bot)) throw new Error('Bot configuration is incomplete');
  const matchesBot = (conversation: TChatConversation) => {
    const extra = conversation.extra as
      | { workspace?: string; assistant_id?: string; preset_assistant_id?: string }
      | undefined;
    const assistantId = conversation.assistant?.id || extra?.assistant_id || extra?.preset_assistant_id;
    return (
      conversation.type === 'aionrs' &&
      assistantId === bot.id &&
      extra?.workspace?.normalize('NFC') === bot.workspace.normalize('NFC')
    );
  };
  const workspaces = (await getClientBusinessSetting('jr.botWorkspaces')) || {};
  const boundId = workspaces[bot.id]?.conversationId;
  if (boundId) {
    const bound = await getConversationOrNull(boundId);
    if (bound && matchesBot(bound)) return bound;
  }
  const bind = async (conversation: TChatConversation) => {
    const latest = (await getClientBusinessSetting('jr.botWorkspaces')) || {};
    await setClientBusinessSetting('jr.botWorkspaces', {
      ...latest,
      [bot.id]: { ...latest[bot.id], workspace: bot.workspace, conversationId: conversation.id },
    });
    return conversation;
  };
  // shortcut: legacy recovery uses the existing 10,000-row window; paginate before supporting larger histories.
  const history = await ipcBridge.database.getUserConversations.invoke({ limit: 10000 });
  const previous = history.items
    .filter(matchesBot)
    .sort((a, b) => b.modified_at - a.modified_at || b.created_at - a.created_at)[0];
  if (previous) return bind(previous);
  if (history.has_more) throw new Error('Conversation history is incomplete');
  const model = selectJrModel(await ipcBridge.mode.listProviders.invoke());
  if (!model) throw new Error('JR MiniMax connection is unavailable');
  // shortcut: Gmail OAuth is incomplete; admit it after real client authorization is supported.
  const servers = (await ipcBridge.mcpService.listServers.invoke()).filter(
    (server) => server.enabled && !isGmailServer(server)
  );
  const conversation = await ipcBridge.conversation.create.invoke({
    name: bot.name,
    model,
    assistant: { id: bot.id, locale: 'pt-BR', conversation_overrides: { mcp_ids: servers.map((server) => server.id) } },
    extra: {
      workspace: bot.workspace,
      custom_workspace: true,
      selected_mcp_server_ids: servers.filter((server) => !server.builtin).map((server) => server.id),
      selected_session_mcp_servers: servers.map(toSessionMcpServer),
    },
  });
  if (!conversation?.id) throw new Error('Conversation was not created');
  try {
    localStorage.setItem(`workspace-preference-${conversation.id}`, 'collapsed');
    if (conversation.project_id) localStorage.setItem(`project-panel-collapse:${conversation.project_id}`, 'collapsed');
  } catch {
    // Navigation must continue when optional layout preferences cannot be stored.
  }
  return bind(conversation);
}
