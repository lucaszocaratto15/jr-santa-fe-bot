import { ipcBridge } from '@/common';
import type { IProvider, TChatConversation, TProviderWithModel } from '@/common/config/storage';
import { isAionrsAssistant } from '@/common/types/agent/assistantTypes';
import { getClientBusinessSetting, setClientBusinessSetting } from '@/renderer/services/clientBusinessSettings';
import type { ClientBusinessSettingMap, JrAppearance } from '@/common/config/clientSettings';
import { normalizeAppearance } from './botAppearance';
import { isPresentableBot } from './JrSidebar/groupBots';
import { connectionPayload, createChromeDraft, isGmailServer, isJrChromeServer } from './Connections/connections';
import { toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { emitter } from '@renderer/utils/emitter';

export const JR_MODEL = 'MiniMax-M3.1-Flash';
export const JR_PROVIDER = 'JR MiniMax';

export const JR_DEFAULT_INSTRUCTIONS =
  'Responda sempre em português do Brasil, inclusive nas mensagens de andamento. Seja claro e breve. Ajude nas tarefas de escritório e projetos desta pasta. Use as ferramentas necessárias e aguarde as confirmações de escrita e execução. Reaproveite resultados já obtidos. Se um campo não existir, informe a ausência sem repetir consultas equivalentes. Verifique cada resultado uma vez e conclua quando o pedido estiver atendido. Não apresente raciocínio interno como resposta.';
export type JrBotInput = {
  name: string;
  instructions: string;
  workspace: string;
  appearance?: JrAppearance;
  learning?: string;
  skillIds?: string[];
  /**
   * Ignored on save. Every bot is stored with Chrome on; a false value is
   * rewritten the next time the bot is loaded.
   */
  useChrome?: boolean;
};
export type JrBot = JrBotInput & {
  id: string;
  teamSelectable?: boolean;
  conversationId?: string;
  /** A section the person named. Workspace folder names are not sections. */
  section?: string;
};

function instructionWithLearning(instructions: string, learning: string): string {
  return learning ? `${instructions.trim()}\n\n## Aprendizados deste bot\n${learning}` : instructions;
}

function instructionWithMemory(instructions: string, learning: string): string {
  return [
    instructionWithLearning(instructions, learning),
    '## Memória entre conversas deste bot',
    'Use a memória persistente do projeto AionRS para guardar decisões, preferências, procedimentos e pendências úteis em conversas futuras. Consulte-a ao retomar um assunto. Não salve credenciais, dados pessoais sensíveis ou documentos completos. Só confirme que algo foi memorizado depois de gravar a informação.',
  ].join('\n\n');
}

export function validateJrBot(input: JrBotInput): 'name' | 'instructions' | 'learning' | 'workspace' | null {
  if (!input.name.trim() || input.name.trim().length > 80) return 'name';
  if (!input.instructions.trim() || input.instructions.length > 12000) return 'instructions';
  if ((input.learning?.length ?? 0) > 12000) return 'learning';
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(input.workspace)) return 'workspace';
  return null;
}

type JrBotRecord = NonNullable<ClientBusinessSettingMap['jr.botWorkspaces']>[string];

const sameIdSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const a = [...left].toSorted();
  const b = [...right].toSorted();
  return a.every((id, index) => id === b[index]);
};

/** Every installed skill, in a stable order. Callers cannot pass a subset. */
export async function listInstalledSkillIds(): Promise<string[]> {
  const skills = await ipcBridge.fs.listAvailableSkills.invoke();
  return Array.from(new Set(skills.map((skill) => skill.name.trim()).filter((skill) => skill.length > 0))).toSorted();
}

/** Null means the catalog could not be read. Load keeps the stored skill ids in that case. */
async function installedSkillIdsOrNull(): Promise<string[] | null> {
  try {
    return await listInstalledSkillIds();
  } catch {
    return null;
  }
}

function enforcedSkillIds(stored: readonly string[] | undefined, installed: readonly string[] | null): string[] {
  return installed ? [...installed] : [...(stored ?? [])];
}

function policyDrift(record: { skillIds?: string[]; useChrome?: boolean }, skillIds: readonly string[]): boolean {
  return record.useChrome === false || !sameIdSet(record.skillIds ?? [], skillIds);
}

/** Rewrite stored bots that opted out of skills or Chrome. Failures stay in memory as enforced. */
async function migrateJrBotRecords(
  records: Record<string, JrBotRecord>,
  installed: readonly string[] | null
): Promise<Record<string, JrBotRecord>> {
  const next = { ...records };
  let changed = false;
  for (const [id, record] of Object.entries(records)) {
    const skillIds = enforcedSkillIds(record.skillIds, installed);
    if (!policyDrift(record, skillIds)) continue;
    changed = true;
    next[id] = { ...record, skillIds, useChrome: true };
    try {
      await ipcBridge.assistants.update.invoke({
        id,
        defaults: { skills: { mode: 'fixed', value: skillIds } },
      });
    } catch {
      // The workspace record is what the next chat reads. A defaults write can be retried on save.
    }
  }
  if (changed) await setClientBusinessSetting('jr.botWorkspaces', next);
  return next;
}

function jrBotFromRecord(
  id: string,
  record: JrBotRecord,
  profile: { name: string; instructions: string; teamSelectable?: boolean },
  skillIds: string[]
): JrBot {
  return {
    id,
    name: profile.name,
    instructions: record.instructions ?? profile.instructions,
    workspace: record.workspace,
    appearance: normalizeAppearance(record.appearance),
    learning: record.learning ?? '',
    skillIds,
    useChrome: true,
    teamSelectable: profile.teamSelectable,
    conversationId: record.conversationId,
    section: record.section,
  };
}

export async function listJrBots(): Promise<JrBot[]> {
  const [assistants, stored, installed] = await Promise.all([
    ipcBridge.assistants.list.invoke(),
    getClientBusinessSetting('jr.botWorkspaces'),
    installedSkillIdsOrNull(),
  ]);
  const workspaces = stored ? await migrateJrBotRecords(stored, installed) : {};
  return assistants
    .filter((assistant) => assistant.source === 'user' && isAionrsAssistant(assistant) && workspaces[assistant.id])
    .map((assistant) =>
      jrBotFromRecord(
        assistant.id,
        workspaces[assistant.id],
        { name: assistant.name, instructions: assistant.context ?? '', teamSelectable: assistant.team_selectable },
        enforcedSkillIds(workspaces[assistant.id].skillIds, installed)
      )
    )
    .filter((bot) => isPresentableBot(bot));
}

export async function getJrBot(id: string): Promise<JrBot> {
  const [detail, stored, installed] = await Promise.all([
    ipcBridge.assistants.get.invoke({ id, locale: 'pt-BR' }),
    getClientBusinessSetting('jr.botWorkspaces'),
    installedSkillIdsOrNull(),
  ]);
  if (detail.source !== 'user' || detail.engine.agent?.type !== 'aionrs' || !stored?.[id]) {
    throw new Error('JR bot not found');
  }
  const workspaces = await migrateJrBotRecords(stored, installed);
  return jrBotFromRecord(
    id,
    workspaces[id],
    {
      name: detail.profile.name,
      instructions: detail.rules.content,
      teamSelectable: detail.team_selectable,
    },
    enforcedSkillIds(workspaces[id].skillIds, installed)
  );
}

export async function saveJrBot(input: JrBotInput, id?: string): Promise<JrBot> {
  const invalid = validateJrBot(input);
  if (invalid) throw new Error(`Invalid bot ${invalid}`);
  const name = input.name.trim();
  const learning = input.learning?.trim() ?? '';
  // Ignore any skill list or Chrome flag from the caller. Employees cannot drop either.
  const skillIds = await listInstalledSkillIds();
  const useChrome = true;
  const previous = id ? await getJrBot(id) : null;
  const workspaces = (await getClientBusinessSetting('jr.botWorkspaces')) || {};
  if (!id) {
    const assistants = await ipcBridge.assistants.list.invoke();
    const runtime = assistants.find(isAionrsAssistant);
    if (!runtime) throw new Error('Embedded agent is unavailable');
    const created = await ipcBridge.assistants.create.invoke({
      name,
      agent_id: runtime.agent_id,
      avatar: '🤖',
      defaults: { skills: { mode: 'fixed', value: skillIds } },
    });
    id = created.id;
  }
  try {
    const written = await ipcBridge.fs.writeAssistantRule.invoke({
      assistant_id: id,
      locale: 'pt-BR',
      content: instructionWithMemory(input.instructions, learning),
    });
    if (!written) throw new Error('Bot instructions were not saved');
    if (previous)
      await ipcBridge.assistants.update.invoke({
        id,
        name,
        avatar: '🤖',
        defaults: { skills: { mode: 'fixed', value: skillIds } },
      });
    await setClientBusinessSetting('jr.botWorkspaces', {
      ...workspaces,
      [id]: {
        ...workspaces[id],
        workspace: input.workspace,
        instructions: input.instructions,
        learning,
        skillIds,
        useChrome,
        ...(input.appearance ? { appearance: normalizeAppearance(input.appearance) } : {}),
      },
    });
    return { ...input, name, learning, skillIds, useChrome, id };
  } catch (error) {
    if (!previous) {
      await ipcBridge.assistants.delete.invoke({ id });
    } else {
      await ipcBridge.fs.writeAssistantRule.invoke({
        assistant_id: id,
        locale: 'pt-BR',
        content: instructionWithLearning(previous.instructions, previous.learning ?? ''),
      });
      await ipcBridge.assistants.update.invoke({
        id,
        name: previous.name,
        defaults: { skills: { mode: 'fixed', value: previous.skillIds ?? [] } },
      });
    }
    throw error;
  }
}

function conversationAssistantId(conversation: TChatConversation): string | undefined {
  const extra = conversation.extra;
  const record =
    extra && typeof extra === 'object'
      ? (extra as { assistant_id?: unknown; preset_assistant_id?: unknown })
      : undefined;
  const fromAssistant = conversation.assistant?.id;
  const fromExtra = typeof record?.assistant_id === 'string' ? record.assistant_id : undefined;
  const fromPreset = typeof record?.preset_assistant_id === 'string' ? record.preset_assistant_id : undefined;
  return fromAssistant || fromExtra || fromPreset;
}

/** Drop chats bound to this bot. A listing or delete failure still lets the bot itself be removed. */
async function removeBotConversations(id: string): Promise<void> {
  let items: TChatConversation[] = [];
  try {
    const history = await ipcBridge.database.getUserConversations.invoke({ limit: 10000 });
    items = Array.isArray(history?.items) ? history.items : [];
  } catch {
    return;
  }
  for (const conversation of items) {
    if (conversationAssistantId(conversation) !== id) continue;
    try {
      await ipcBridge.conversation.remove.invoke({ id: conversation.id });
      emitter.emit('conversation.deleted', conversation.id);
    } catch {
      // One stuck chat must not keep the bot in the sidebar.
    }
  }
}

export async function deleteJrBot(id: string): Promise<void> {
  await getJrBot(id);
  await removeBotConversations(id);
  await ipcBridge.assistants.delete.invoke({ id });
  const workspaces = { ...(await getClientBusinessSetting('jr.botWorkspaces')) };
  delete workspaces[id];
  await setClientBusinessSetting('jr.botWorkspaces', workspaces);
}

function listedModelId(model: unknown): string {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object' && 'id' in model && typeof model.id === 'string') return model.id;
  return '';
}

/** Accept an array, `{ id }` entries, or a JSON string stored in the providers table. */
function listedModelIds(models: unknown): string[] {
  if (typeof models === 'string') {
    const trimmed = models.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(listedModelId).filter((id) => id.length > 0);
      } catch {
        return [];
      }
    }
    return trimmed ? [trimmed] : [];
  }
  return (Array.isArray(models) ? models : []).map(listedModelId).filter((id) => id.length > 0);
}

function providerEnabled(enabled: unknown): boolean {
  return enabled !== false && enabled !== 0;
}

export function selectJrModel(providers: IProvider[] | null | undefined): TProviderWithModel | null {
  const provider = (providers ?? []).find(
    (item) =>
      item.name === JR_PROVIDER && providerEnabled(item.enabled) && listedModelIds(item.models).includes(JR_MODEL)
  );
  return provider ? { ...provider, api_key: '', use_model: JR_MODEL } : null;
}

/** The message shown under the banner and written to `logs/jr.log`. Secrets are stripped. */
export function openErrorMessage(error: unknown): string {
  const raw = isBackendHttpError(error)
    ? [error.backendMessage || error.message, error.code].filter((part) => part.length > 0).join(' ')
    : error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error';
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted]')
    .slice(0, 4000);
}

export function isMissingAssistantError(error: unknown): boolean {
  const code = isBackendHttpError(error) ? error.code : '';
  const message = `${code} ${openErrorMessage(error)}`;
  return /ASSISTANT_NOT_FOUND|assistant was not found|assistant not found/i.test(message);
}

/** Show the failure in the renderer console and ask the main process to append `userData/logs/jr.log`. */
export function reportJrOpenError(error: unknown): string {
  const message = openErrorMessage(error);
  console.error('[JR] Failed to open bot:', message);
  const stack = error instanceof Error ? error.stack : undefined;
  void ipcBridge.jr.reportOpenError.invoke({ message, ...(stack ? { stack } : {}) }).catch((logError: unknown) => {
    console.error('[JR] Could not write logs/jr.log:', logError);
  });
  return message;
}

/** Ask the main process to register the local gateway. A failure is kept so the banner can show it. */
async function ensureJrGateway(): Promise<void> {
  await ipcBridge.jr.ensureGateway.invoke();
}

/**
 * The renderer catalog can miss a provider owned by `system_default_user`.
 * The main process reads the same loopback list the gateway writer uses.
 */
export async function providersForNewConversation(): Promise<{
  providers: IProvider[] | null | undefined;
  listError: unknown;
}> {
  let providers: IProvider[] | null | undefined;
  let listError: unknown;
  try {
    providers = await ipcBridge.mode.listProviders.invoke();
  } catch (error) {
    providers = [];
    listError = error;
  }
  if (selectJrModel(providers)) return { providers, listError };
  try {
    const local = await ipcBridge.jr.readProviders.invoke();
    if (selectJrModel(local)) return { providers: local, listError };
  } catch (error) {
    listError = listError ?? error;
  }
  return { providers, listError };
}

async function recreateBotAssistant(bot: JrBot, skillIds: readonly string[]): Promise<void> {
  const assistants = await ipcBridge.assistants.list.invoke();
  const runtime = assistants.find((assistant) => isAionrsAssistant(assistant));
  if (!runtime) throw new Error('Embedded agent is unavailable');
  await ipcBridge.assistants.create.invoke({
    id: bot.id,
    name: bot.name,
    agent_id: runtime.agent_id,
    avatar: '🤖',
    defaults: { skills: { mode: 'fixed', value: [...skillIds] } },
  });
  const written = await ipcBridge.fs.writeAssistantRule.invoke({
    assistant_id: bot.id,
    locale: 'pt-BR',
    content: instructionWithMemory(bot.instructions, bot.learning ?? ''),
  });
  if (!written) throw new Error('Bot instructions were not saved');
}

/** Recreate the assistant row when the workspace record survived and the assistant did not. */
async function ensureBotAssistant(bot: JrBot, skillIds: readonly string[]): Promise<void> {
  let detail: Awaited<ReturnType<typeof ipcBridge.assistants.get.invoke>> | undefined;
  try {
    detail = await ipcBridge.assistants.get.invoke({ id: bot.id, locale: 'pt-BR' });
  } catch {
    // The row is missing. Create it again with the same id.
  }
  if (detail?.source === 'user' && detail.engine?.agent?.type === 'aionrs') {
    if (!detail.rules.content.includes('## Memória entre conversas deste bot')) {
      const written = await ipcBridge.fs.writeAssistantRule.invoke({
        assistant_id: bot.id,
        locale: 'pt-BR',
        content: instructionWithMemory(bot.instructions, bot.learning ?? ''),
      });
      if (!written) throw new Error('Bot instructions were not saved');
    }
    return;
  }
  await recreateBotAssistant(bot, skillIds);
}

/** Create or enable the app Chrome connector so a new bot can use it immediately. */
async function ensureJrChromeServer(): Promise<void> {
  const servers = await ipcBridge.mcpService.listServers.invoke();
  const existing = servers.find(isJrChromeServer);
  if (existing?.enabled) return;
  if (existing) {
    await ipcBridge.mcpService.toggleServer.invoke({ id: existing.id });
    return;
  }
  const { cacheDir } = await ipcBridge.application.systemInfo.invoke();
  const created = await ipcBridge.mcpService.createServer.invoke(connectionPayload(createChromeDraft(cacheDir)));
  if (!created.enabled) await ipcBridge.mcpService.toggleServer.invoke({ id: created.id });
}

/** Enabled connectors for a JR chat. Chrome is created when it is missing. Gmail stays out. */
async function jrConversationServers() {
  try {
    await ensureJrChromeServer();
  } catch {
    // Chrome is required, but a missing runtime must not block the chat.
  }
  return (await ipcBridge.mcpService.listServers.invoke()).filter((server) => server.enabled && !isGmailServer(server));
}

/**
 * Reuse a stored chat as it was created.
 * `extra.skills` and the MCP snapshot are immutable after creation; patching them
 * returns 400 BAD_REQUEST and must not block opening the bot.
 * Full skills and Chrome are applied only when a new conversation is created.
 */
function reuseStoredConversation(conversation: TChatConversation): TChatConversation {
  return conversation;
}

const openingConversations = new Map<string, Promise<TChatConversation>>();
let conversationQueue: Promise<unknown> = Promise.resolve();

/** Open the bot's durable conversation, coalescing concurrent navigation requests. */
export function startJrConversation(
  bot: JrBot,
  options: { newConversation?: boolean } = {}
): Promise<TChatConversation> {
  const newConversation = options.newConversation === true;
  const openingKey = newConversation ? `${bot.id}:new` : bot.id;
  const pending = openingConversations.get(openingKey);
  if (pending) return pending;
  // Serialize whole-map writes so opening different bots cannot discard each other's bindings.
  const operation = conversationQueue.then(() => resolveJrConversation(bot, newConversation));
  conversationQueue = operation.catch((): undefined => undefined);
  openingConversations.set(openingKey, operation);
  void operation.then(
    () => openingConversations.delete(openingKey),
    () => openingConversations.delete(openingKey)
  );
  return operation;
}

async function resolveJrConversation(bot: JrBot, newConversation: boolean): Promise<TChatConversation> {
  if (validateJrBot(bot) === 'instructions') bot = { ...bot, instructions: JR_DEFAULT_INSTRUCTIONS };
  if (validateJrBot(bot)) throw new Error('Bot configuration is incomplete');
  await ipcBridge.jr.configureWorkspace.invoke({ workspace: bot.workspace });
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
  let skillIds: string[];
  try {
    skillIds = await listInstalledSkillIds();
  } catch {
    skillIds = [...(bot.skillIds ?? [])];
  }
  const workspaces = (await getClientBusinessSetting('jr.botWorkspaces')) || {};
  const boundId = workspaces[bot.id]?.conversationId;
  if (!newConversation && boundId) {
    const bound = await getConversationOrNull(boundId);
    if (bound && matchesBot(bound)) return reuseStoredConversation(bound);
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
  if (!newConversation) {
    const history = await ipcBridge.database.getUserConversations.invoke({ limit: 10000 });
    const previous = history.items
      .filter(matchesBot)
      .toSorted((a, b) => b.modified_at - a.modified_at || b.created_at - a.created_at)[0];
    if (previous) return reuseStoredConversation(await bind(previous));
    if (history.has_more) throw new Error('Conversation history is incomplete');
  }
  let gatewayError: unknown;
  try {
    await ensureJrGateway();
  } catch (error) {
    // The provider row may already be enabled. Keep going and surface this only if selection fails.
    gatewayError = error;
  }
  const { providers, listError } = await providersForNewConversation();
  const model = selectJrModel(providers);
  if (!model) {
    if (gatewayError instanceof Error) throw gatewayError;
    if (listError instanceof Error) throw listError;
    throw new Error('JR MiniMax connection is unavailable');
  }
  const servers = await jrConversationServers();
  await ensureBotAssistant(bot, skillIds);
  const payload = {
    name: bot.name,
    model,
    assistant: {
      id: bot.id,
      locale: 'pt-BR' as const,
      conversation_overrides: { skill_ids: skillIds, mcp_ids: servers.map((server) => server.id) },
    },
    extra: {
      workspace: bot.workspace,
      custom_workspace: true,
      selected_mcp_server_ids: servers.filter((server) => !server.builtin).map((server) => server.id),
      selected_session_mcp_servers: servers.map(toSessionMcpServer),
    },
  };
  let conversation: TChatConversation;
  try {
    conversation = await ipcBridge.conversation.create.invoke(payload);
  } catch (error) {
    if (!isMissingAssistantError(error)) throw error;
    await recreateBotAssistant(bot, skillIds);
    conversation = await ipcBridge.conversation.create.invoke(payload);
  }
  if (!conversation?.id) throw new Error('Conversation was not created');
  try {
    localStorage.setItem(`workspace-preference-${conversation.id}`, 'collapsed');
    if (conversation.project_id) localStorage.setItem(`project-panel-collapse:${conversation.project_id}`, 'collapsed');
  } catch {
    // Navigation must continue when optional layout preferences cannot be stored.
  }
  return bind(conversation);
}
