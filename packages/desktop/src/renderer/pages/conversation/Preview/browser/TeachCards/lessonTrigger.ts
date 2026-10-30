/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Normalized (lowercase, no accents) words that mean "that worked". */
export const APPROVAL_WORDS: readonly string[] = [
  'isso',
  'agora sim',
  'perfeito',
  'certo',
  'deu certo',
  'obrigado',
  'obrigada',
  'valeu',
  'otimo',
  'show',
  'exato',
  'funcionou',
];

export type TriggerMessage = { id: string; role: 'user' | 'assistant'; text: string };

/** How many user messages after the first make the stretch "moved on" without an approval word. */
const MOVED_ON_AFTER = 3;

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const startsWithApproval = (text: string): boolean => {
  const normalized = normalize(text);
  return APPROVAL_WORDS.some((word) => normalized === word || normalized.startsWith(`${word} `));
};

/** Messages after `lastOfferedId` (all of them when it is null or no longer in the list). */
export function stretchAfter(messages: TriggerMessage[], lastOfferedId: string | null): TriggerMessage[] {
  if (!lastOfferedId) return messages;
  const index = messages.findIndex((message) => message.id === lastOfferedId);
  return index === -1 ? messages : messages.slice(index + 1);
}

/** Conservative gate before paying for an extraction; the extractor's `corrected:false` is the final filter. */
export function shouldOffer(messages: TriggerMessage[], lastOfferedId: string | null, turnOk: boolean): boolean {
  if (!turnOk) return false;
  const users = stretchAfter(messages, lastOfferedId).filter((message) => message.role === 'user');
  if (users.length < 2) return false;
  if (startsWithApproval(users[users.length - 1].text)) return true;
  return users.length - 1 >= MOVED_ON_AFTER;
}
