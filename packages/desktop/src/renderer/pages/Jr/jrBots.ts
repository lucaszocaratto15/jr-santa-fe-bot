import { ipcBridge } from '@/common';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { isAionrsAssistant } from '@/common/types/agent/assistantTypes';
import { getClientBusinessSetting, setClientBusinessSetting } from '@/renderer/services/clientBusinessSettings';
import type { JrAppearance } from '@/common/config/clientSettings';
import { normalizeAppearance } from './botAppearance';
import { isGmailServer } from './Connections/connections';
import { toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';

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

export async function startJrConversation(bot: JrBot, input: string) {
  if (validateJrBot(bot)) throw new Error('Bot configuration is incomplete');
  const model = selectJrModel(await ipcBridge.mode.listProviders.invoke());
  if (!model) throw new Error('JR MiniMax connection is unavailable');
  // shortcut: Gmail OAuth is incomplete; admit it after real client authorization is supported.
  const servers = (await ipcBridge.mcpService.listServers.invoke()).filter(
    (server) => server.enabled && !isGmailServer(server)
  );
  return ipcBridge.conversation.create.invoke({
    name: input.trim().slice(0, 120) || bot.name,
    model,
    assistant: { id: bot.id, locale: 'pt-BR', conversation_overrides: { mcp_ids: servers.map((server) => server.id) } },
    extra: {
      workspace: bot.workspace,
      custom_workspace: true,
      selected_mcp_server_ids: servers.filter((server) => !server.builtin).map((server) => server.id),
      selected_session_mcp_servers: servers.map(toSessionMcpServer),
    },
  });
}
