/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TFunction } from 'i18next';
import { queueConversationIntent } from '@renderer/pages/conversation/Preview/browser/TeachCards/teachStore';
import { startJrConversation, type JrBot } from '@renderer/pages/Jr/jrBots';

/** Taught skills are named `jr-tarefa-<slug>` (see process/services/teach/recording/skillDraft.ts). */
export const TAUGHT_SKILL_PREFIX = 'jr-tarefa-';

/** A taught skill name between backticks, as the run prompts write it. */
const TAUGHT_SKILL_IN_PROMPT_RE = /`(jr-tarefa-[a-z0-9-]{3,48})`/;

export type TaughtTaskSummary = { name: string; description: string };

/** The taught skill a prompt (or a cron job's message) runs, or null. */
export function taughtSkillFromPrompt(text: string): string | null {
  return TAUGHT_SKILL_IN_PROMPT_RE.exec(text)?.[1] ?? null;
}

/** The message that runs a taught task now (`now`) or from a schedule (`scheduled`). */
export function buildRunPrompt(t: TFunction, task: TaughtTaskSummary, mode: 'now' | 'scheduled'): string {
  const name = `\`${task.name}\``;
  return mode === 'now'
    ? t('common.jr.teach.tasks.runPrompt', { name, description: task.description })
    : t('common.jr.teach.tasks.scheduledPrompt', { name });
}

/** The bot open in the sidebar (`?bot=`), else the first bot, else null. */
export function pickRunBot(bots: readonly JrBot[], activeBotId: string | null): JrBot | null {
  return bots.find((bot) => bot.id === activeBotId) ?? bots[0] ?? null;
}

/**
 * Executar: opens a new conversation of `bot` (all installed skills, JR MCPs), queues the
 * run prompt as its first message and the in-app browser as its open intent, then navigates.
 * Rejects (and navigates nowhere) when the conversation cannot be created.
 */
export async function runTaughtTask(deps: {
  bot: JrBot;
  prompt: string;
  navigate: (path: string) => void;
}): Promise<void> {
  const conversation = await startJrConversation(deps.bot, { newConversation: true });
  sessionStorage.setItem(`aionrs_initial_message_${conversation.id}`, JSON.stringify({ input: deps.prompt }));
  queueConversationIntent(conversation.id, { openBrowser: true });
  deps.navigate(`/conversation/${conversation.id}?bot=${encodeURIComponent(deps.bot.id)}`);
}
