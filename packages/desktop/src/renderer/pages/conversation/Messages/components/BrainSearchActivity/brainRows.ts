/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolMessage } from '@/common/chat/normalizeToolCall';
import { normalizeToolMessages } from '@/common/chat/normalizeToolCall';
import { isBrainSearchTool } from './parseBrainSearch';

type ListItem = { type?: string; position?: string; id?: string; messages?: ToolMessage[] };

/**
 * One brain animation per bot reply: maps each tool-summary row id to the tool messages whose
 * brain_search calls it animates. The reply's first row with a brain call gets every call of
 * the reply; later rows get null. A reply runs until the next user (right) message.
 */
export function brainRowsPerReply(items: readonly ListItem[]): Map<string, ToolMessage[] | null> {
  const rows = new Map<string, ToolMessage[] | null>();
  let owner: ToolMessage[] | null = null;
  for (const item of items) {
    if (item.position === 'right') {
      owner = null;
      continue;
    }
    if (item.type !== 'tool_summary' || !item.id || !item.messages) continue;
    const brainMessages = item.messages.filter((message) =>
      normalizeToolMessages([message]).some((call) => isBrainSearchTool(call.name))
    );
    if (brainMessages.length === 0) continue;
    if (owner) {
      owner.push(...brainMessages);
      rows.set(item.id, null);
    } else {
      owner = [...brainMessages];
      rows.set(item.id, owner);
    }
  }
  return rows;
}
