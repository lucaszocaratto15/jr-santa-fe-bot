export type GroupableBot = {
  id: string;
  name: string;
  workspace: string;
};

export type BotSection<T extends GroupableBot> = {
  id: string;
  label: string;
  bots: T[];
};

/** Folder name used when a workspace path has no usable directory segment. */
export const UNSECTIONED_ID = 'unsectioned';

/** Drop target above the sections. Dragging a bot here pins it. */
export const PIN_ZONE_ID = 'pin-zone';

/** Prefix for section header drop targets. The folder id is appended. */
export const SECTION_PREFIX = 'section:';

export type SidebarLayout = {
  pinnedIds: string[];
  order: string[];
  collapsed: Record<string, boolean>;
};

export const EMPTY_SIDEBAR_LAYOUT: SidebarLayout = { pinnedIds: [], order: [], collapsed: {} };

/** Last directory of a workspace path. Windows and POSIX separators are both accepted. */
export function workspaceFolderLabel(workspace: string): string {
  const trimmed = workspace.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return UNSECTIONED_ID;
  const parts = trimmed.split(/[\\/]/).filter((part) => part.length > 0);
  const name = parts[parts.length - 1] ?? '';
  if (!name || /^[A-Za-z]:$/.test(name)) return UNSECTIONED_ID;
  return name;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

/** Drops malformed saved sidebar state instead of throwing. */
export function sanitizeSidebarLayout(value: unknown): SidebarLayout {
  if (!value || typeof value !== 'object') {
    return { pinnedIds: [], order: [], collapsed: {} };
  }
  const record = value as Record<string, unknown>;
  const collapsed: Record<string, boolean> = {};
  if (record.collapsed && typeof record.collapsed === 'object') {
    for (const [key, flag] of Object.entries(record.collapsed as Record<string, unknown>)) {
      if (typeof flag === 'boolean') collapsed[key] = flag;
    }
  }
  return { pinnedIds: uniqueStrings(record.pinnedIds), order: uniqueStrings(record.order), collapsed };
}

function orderedBots<T extends { id: string }>(bots: readonly T[], order: readonly string[]): T[] {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const seen = new Set<string>();
  const result: T[] = [];
  for (const id of order) {
    const bot = byId.get(id);
    if (!bot || seen.has(id)) continue;
    seen.add(id);
    result.push(bot);
  }
  for (const bot of bots) {
    if (seen.has(bot.id)) continue;
    seen.add(bot.id);
    result.push(bot);
  }
  return result;
}

/**
 * Pinned bots stay above folder sections. Nothing is pinned unless `pinnedIds`
 * says so. Section membership follows the workspace folder; order inside and
 * across sections follows `layout.order`.
 */
export function groupBots<T extends GroupableBot>(
  bots: readonly T[],
  layout: SidebarLayout = EMPTY_SIDEBAR_LAYOUT
): { pinned: T[]; sections: BotSection<T>[] } {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const pinned: T[] = [];
  const pinnedIds = new Set<string>();
  for (const id of layout.pinnedIds) {
    const bot = byId.get(id);
    if (!bot || pinnedIds.has(id)) continue;
    pinnedIds.add(id);
    pinned.push(bot);
  }
  const groups = new Map<string, T[]>();
  for (const bot of orderedBots(bots, layout.order)) {
    if (pinnedIds.has(bot.id)) continue;
    const label = workspaceFolderLabel(bot.workspace);
    const list = groups.get(label);
    if (list) list.push(bot);
    else groups.set(label, [bot]);
  }
  return {
    pinned,
    sections: [...groups.entries()].map(([label, items]) => ({ id: label, label, bots: items })),
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function moveIndex(ids: readonly string[], from: number, to: number): string[] {
  if (from < 0 || to < 0 || from === to) return [...ids];
  const next = ids.slice();
  const [item] = next.splice(from, 1);
  if (item === undefined) return [...ids];
  next.splice(to, 0, item);
  return next;
}

function insertBefore(ids: readonly string[], activeId: string, overId: string): string[] {
  const next = ids.filter((id) => id !== activeId);
  const index = next.indexOf(overId);
  if (index < 0) return [...ids];
  next.splice(index, 0, activeId);
  return next;
}

function knownOrder(bots: readonly { id: string }[], order: readonly string[]): string[] {
  return orderedBots(bots, order).map((bot) => bot.id);
}

/**
 * Pin when dropped on the top zone or a pinned bot. Dropping on a section or
 * an unpinned bot unpins and reorders. The same layout object is returned when
 * nothing changes.
 */
export function applySidebarDrag(
  bots: readonly GroupableBot[],
  layout: SidebarLayout,
  activeId: string,
  overId: string
): SidebarLayout {
  if (!overId || activeId === overId) return layout;
  const ids = new Set(bots.map((bot) => bot.id));
  if (!ids.has(activeId)) return layout;

  const pinnedIds = layout.pinnedIds.filter((id) => ids.has(id));
  const order = knownOrder(bots, layout.order);
  const pinnedSet = new Set(pinnedIds);

  if (overId === PIN_ZONE_ID && !ids.has(PIN_ZONE_ID)) {
    if (pinnedIds[pinnedIds.length - 1] === activeId) return layout;
    const nextPins = [...pinnedIds.filter((id) => id !== activeId), activeId];
    return { ...layout, pinnedIds: nextPins, order };
  }

  if (ids.has(overId) && pinnedSet.has(overId)) {
    const nextPins = pinnedSet.has(activeId)
      ? moveIndex(pinnedIds, pinnedIds.indexOf(activeId), pinnedIds.indexOf(overId))
      : insertBefore(pinnedIds, activeId, overId);
    if (sameIds(nextPins, pinnedIds)) return layout;
    return { ...layout, pinnedIds: nextPins, order };
  }

  const sectionId = overId.startsWith(SECTION_PREFIX) && !ids.has(overId) ? overId.slice(SECTION_PREFIX.length) : null;
  if (!sectionId && !(ids.has(overId) && !pinnedSet.has(overId))) return layout;

  const nextPins = pinnedIds.filter((id) => id !== activeId);
  let nextOrder = order;
  if (ids.has(overId)) {
    nextOrder = moveIndex(order, order.indexOf(activeId), order.indexOf(overId));
  } else if (sectionId) {
    const anchor = bots
      .filter(
        (bot) => bot.id !== activeId && !nextPins.includes(bot.id) && workspaceFolderLabel(bot.workspace) === sectionId
      )
      .map((bot) => bot.id)
      .toSorted((left, right) => order.indexOf(left) - order.indexOf(right))[0];
    if (anchor) nextOrder = insertBefore(order, activeId, anchor);
  }
  if (sameIds(nextPins, pinnedIds) && sameIds(nextOrder, order)) return layout;
  return { ...layout, pinnedIds: nextPins, order: nextOrder };
}

/** Missing means collapsed, except the section that contains the open bot. */
export function isSectionExpanded(layout: SidebarLayout, sectionId: string, containsActive: boolean): boolean {
  const flag = layout.collapsed[sectionId];
  if (flag === true) return false;
  if (flag === false) return true;
  return containsActive;
}

export function setSectionCollapsed(layout: SidebarLayout, sectionId: string, collapsed: boolean): SidebarLayout {
  if (layout.collapsed[sectionId] === collapsed) return layout;
  return { ...layout, collapsed: { ...layout.collapsed, [sectionId]: collapsed } };
}

export type PreviewMessage = {
  type?: string;
  hidden?: boolean;
  content?: { content?: unknown } | string | null;
};

function messageText(message: PreviewMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (message.content && typeof message.content.content === 'string') return message.content.content;
  return '';
}

function asPreviewMessage(value: unknown): PreviewMessage | null {
  if (!value || typeof value !== 'object') return null;
  return value as PreviewMessage;
}

/** Newest visible text, with whitespace collapsed. Blank when there is none. */
export function previewFromMessages(messages: readonly unknown[] | null | undefined): string {
  if (!messages) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asPreviewMessage(messages[index]);
    if (!message || message.hidden) continue;
    if (message.type && message.type !== 'text') continue;
    const text = messageText(message).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

/** One preview per bot. A missing conversation or a failed read becomes an empty string. */
export async function loadBotPreviews(
  bots: readonly { id: string; conversationId?: string | null }[],
  fetchMessages: (conversationId: string) => Promise<readonly unknown[] | null | undefined>
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    bots.map(async (bot) => {
      if (!bot.conversationId) return [bot.id, ''] as const;
      try {
        const messages = await fetchMessages(bot.conversationId);
        return [bot.id, previewFromMessages(messages)] as const;
      } catch {
        return [bot.id, ''] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}

export type TeamChatRef = {
  id: string;
  assistants?: Array<{ assistant_id?: string | null }>;
};

/** Team rows whose members are all bots in this sidebar. */
export function teamChatsForBots<T extends TeamChatRef>(teams: readonly T[], botIds: ReadonlySet<string>): T[] {
  return teams.filter(
    (team) =>
      Array.isArray(team.assistants) &&
      team.assistants.length > 1 &&
      team.assistants.every(
        (assistant) => typeof assistant.assistant_id === 'string' && botIds.has(assistant.assistant_id)
      )
  );
}
