/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pre-update safety net: copy the employee profile (bots, conversations, settings, skills,
 * lessons, vault and JR session) before the app hands off to the installer. Updates keep
 * userData, but a schema migration or a failed installer can still break a profile, and a
 * local backup makes that recoverable without asking the employee to reinstall.
 */

import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_KEEP = 3;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const BACKUP_DIRNAME = 'jr-update-backups';

/** Caches and logs are large and can be rebuilt; they are never part of a profile backup. */
const SKIPPED = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'GrShaderCache',
  'ShaderCache',
  'Crashpad',
  'blob_storage',
  'logs',
  BACKUP_DIRNAME,
  'component_crx_cache',
  'extensions_crx_cache',
  'Dictionaries',
]);

/** Copy order: the database and settings first, large workspaces last. */
const PRIORITY = [
  'aionui',
  'config',
  'jr-access',
  'jr-vault',
  'jr-lessons',
  'jr-learn',
  'jr-handbook',
  'taught-tasks',
  'taught-shots',
  'jr-workspaces',
];

const priority = (name: string): number => {
  const index = PRIORITY.indexOf(name);
  return index === -1 ? PRIORITY.length : index;
};

const sizeOf = async (target: string, budget: number): Promise<number> => {
  let info;
  try {
    info = await lstat(target);
  } catch {
    return 0;
  }
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (SKIPPED.has(entry.name)) continue;
    total += await sizeOf(path.join(target, entry.name), budget - total);
    if (total > budget) return total;
  }
  return total;
};

/** Deletes the oldest backups so only `keep` remain. */
export async function pruneBackups(root: string, keep = DEFAULT_KEEP): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of directories.slice(0, Math.max(0, directories.length - keep))) {
    try {
      await rm(path.join(root, name), { recursive: true, force: true });
    } catch {
      // Best effort; a locked old backup must not block the update.
    }
  }
}

export type BackupOptions = {
  userData: string;
  version: string;
  keep?: number;
  maxBytes?: number;
  now?: () => Date;
};

/**
 * Copies the profile into `userData/jr-update-backups/<version>-<timestamp>`. Returns the
 * backup path, or null when there is nothing to copy. Never throws for a single unreadable
 * entry: the goal is best-effort protection, not blocking the update.
 */
export async function backupUserData(options: BackupOptions): Promise<string | null> {
  const { userData, version } = options;
  if (!userData || !path.isAbsolute(userData)) return null;
  const keep = options.keep ?? DEFAULT_KEEP;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  const root = path.join(userData, BACKUP_DIRNAME);
  await mkdir(root, { recursive: true });
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const safeVersion = (version || 'unknown').replace(/[^0-9A-Za-z._-]/g, '_');
  const target = path.join(root, `${safeVersion}-${stamp}`);
  await mkdir(target, { recursive: true });

  let copied = 0;
  let entries;
  try {
    entries = await readdir(userData, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((left, right) => priority(left.name) - priority(right.name));
  for (const entry of entries) {
    if (SKIPPED.has(entry.name) || entry.name.startsWith('.')) continue;
    const source = path.join(userData, entry.name);
    const size = await sizeOf(source, maxBytes - copied);
    if (copied + size > maxBytes) continue;
    try {
      await cp(source, path.join(target, entry.name), {
        recursive: true,
        force: true,
        dereference: true,
        filter: (file) => !SKIPPED.has(path.basename(file)),
      });
      copied += size;
    } catch {
      // Best effort: an unreadable cache or locked file must not block the update.
    }
  }
  await pruneBackups(root, keep);
  return target;
}
