/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LearnExclusion } from '@/common/types/agent/learnTypes';
import { DEFAULT_EXCLUSIONS } from './privacyFilter';
import { ensurePrivateDir, writePrivateFile } from './sampleStore';

export type LearnSettingsData = {
  /**
   * Local date (YYYY-MM-DD) of the last pause: the only trace of it, kept just to refuse a
   * second pause on the same day. No time, no duration; never logged or sent anywhere.
   */
  pauseDay: string | null;
  exclusions: LearnExclusion[];
  /** Last successful insights run. */
  lastSummaryAt: number | null;
  /** Insights attempts on the local calendar day `day` (YYYY-MM-DD). */
  attempts: { day: string; count: number };
};

export type LearnSettings = {
  read(): Promise<LearnSettingsData>;
  write(patch: Partial<LearnSettingsData>): Promise<LearnSettingsData>;
};

const MAX_PATTERN = 200;

export const defaultLearnSettings = (): LearnSettingsData => ({
  pauseDay: null,
  exclusions: [...DEFAULT_EXCLUSIONS],
  lastSummaryAt: null,
  attempts: { day: '', count: 0 },
});

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Keep only well-formed rules; trims patterns and drops empty ones. */
export function sanitizeExclusions(value: unknown): LearnExclusion[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rules: LearnExclusion[] = [];
  for (const item of value) {
    if (!record(item)) continue;
    const { id, kind, pattern, builtin } = item;
    if (typeof id !== 'string' || !id || id.length > 100 || seen.has(id)) continue;
    if (kind !== 'app' && kind !== 'domain' && kind !== 'title') continue;
    if (typeof pattern !== 'string') continue;
    const trimmed = pattern.trim().slice(0, MAX_PATTERN);
    if (!trimmed) continue;
    seen.add(id);
    rules.push({ id, kind, pattern: trimmed, builtin: builtin === true });
  }
  return rules;
}

function parseSettings(value: unknown): LearnSettingsData {
  const defaults = defaultLearnSettings();
  if (!record(value)) return defaults;
  const attempts = record(value.attempts) ? value.attempts : {};
  return {
    pauseDay: typeof value.pauseDay === 'string' && DAY_PATTERN.test(value.pauseDay) ? value.pauseDay : null,
    exclusions: Array.isArray(value.exclusions) ? sanitizeExclusions(value.exclusions) : defaults.exclusions,
    lastSummaryAt: finiteOrNull(value.lastSummaryAt),
    attempts: {
      day: typeof attempts.day === 'string' ? attempts.day : '',
      count: typeof attempts.count === 'number' && attempts.count >= 0 ? attempts.count : 0,
    },
  };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** `settings.json` (no observation data). Reads never create files. */
export function createLearnSettings(root: string): LearnSettings {
  const settingsFile = join(root, 'settings.json');
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => {}).then(operation);
    queue = next;
    return next;
  };
  const read = async () => parseSettings(await readJson(settingsFile));

  return {
    read,
    write: (patch) =>
      serialize(async () => {
        const next = parseSettings({ ...(await read()), ...patch });
        await ensurePrivateDir(root);
        await writePrivateFile(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
        return next;
      }),
  };
}
