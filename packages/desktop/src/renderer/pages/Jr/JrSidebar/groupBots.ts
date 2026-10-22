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

/** Last directory of a workspace path. Windows and POSIX separators are both accepted. */
export function workspaceFolderLabel(workspace: string): string {
  const trimmed = workspace.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return UNSECTIONED_ID;
  const parts = trimmed.split(/[\\/]/).filter((part) => part.length > 0);
  const name = parts[parts.length - 1] ?? '';
  if (!name || /^[A-Za-z]:$/.test(name)) return UNSECTIONED_ID;
  return name;
}

/**
 * Up to three bots stay pinned as the avatar grid. The rest are grouped by
 * workspace folder so the sidebar can collapse each section.
 */
export function groupBots<T extends GroupableBot>(bots: readonly T[]): { pinned: T[]; sections: BotSection<T>[] } {
  const pinned = bots.slice(0, 3);
  const pinnedIds = new Set(pinned.map((bot) => bot.id));
  const groups = new Map<string, T[]>();
  for (const bot of bots) {
    if (pinnedIds.has(bot.id)) continue;
    const label = workspaceFolderLabel(bot.workspace);
    const list = groups.get(label);
    if (list) list.push(bot);
    else groups.set(label, [bot]);
  }
  return {
    pinned: [...pinned],
    sections: [...groups.entries()].map(([label, items]) => ({ id: label, label, bots: items })),
  };
}
