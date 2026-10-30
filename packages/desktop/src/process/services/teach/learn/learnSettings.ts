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
  enabled: boolean;
  /** End of a timed pause; null with `paused` = until resumed. */
  pausedUntil: number | null;
  paused: boolean;
  exclusions: LearnExclusion[];
  /** Last successful insights run. */
  lastSummaryAt: number | null;
  /** Insights attempts on the local calendar day `day` (YYYY-MM-DD). */
  attempts: { day: string; count: number };
};

export type ConsentEvent = {
  type: 'accept' | 'revoke';
  termVersion: string;
  at: string;
  user: { id: string; name: string } | null;
};

export type LearnSettings = {
  read(): Promise<LearnSettingsData>;
  write(patch: Partial<LearnSettingsData>): Promise<LearnSettingsData>;
  consent(): Promise<ConsentEvent[]>;
  appendConsent(event: ConsentEvent): Promise<void>;
};

const MAX_PATTERN = 200;

export const defaultLearnSettings = (): LearnSettingsData => ({
  enabled: false,
  pausedUntil: null,
  paused: false,
  exclusions: [...DEFAULT_EXCLUSIONS],
  lastSummaryAt: null,
  attempts: { day: '', count: 0 },
});

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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
    enabled: value.enabled === true,
    pausedUntil: finiteOrNull(value.pausedUntil),
    paused: value.paused === true,
    exclusions: Array.isArray(value.exclusions) ? sanitizeExclusions(value.exclusions) : defaults.exclusions,
    lastSummaryAt: finiteOrNull(value.lastSummaryAt),
    attempts: {
      day: typeof attempts.day === 'string' ? attempts.day : '',
      count: typeof attempts.count === 'number' && attempts.count >= 0 ? attempts.count : 0,
    },
  };
}

function parseConsent(value: unknown): ConsentEvent[] {
  if (!record(value) || !Array.isArray(value.events)) return [];
  return value.events.filter((event): event is ConsentEvent => {
    if (!record(event)) return false;
    const user = event.user;
    return (
      (event.type === 'accept' || event.type === 'revoke') &&
      typeof event.termVersion === 'string' &&
      typeof event.at === 'string' &&
      (user === null || (record(user) && typeof user.id === 'string' && typeof user.name === 'string'))
    );
  });
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The last event when it is an accept; null when there is none or the user revoked since. */
export function latestAccept(events: ConsentEvent[]): ConsentEvent | null {
  const last = events.at(-1);
  return last?.type === 'accept' ? last : null;
}

/** `settings.json` (no observation data) and the `consent.json` proof log. Reads never create files. */
export function createLearnSettings(root: string): LearnSettings {
  const settingsFile = join(root, 'settings.json');
  const consentFile = join(root, 'consent.json');
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => {}).then(operation);
    queue = next;
    return next;
  };
  const read = async () => parseSettings(await readJson(settingsFile));
  const consent = async () => parseConsent(await readJson(consentFile));

  return {
    read,
    consent,
    write: (patch) =>
      serialize(async () => {
        const next = parseSettings({ ...(await read()), ...patch });
        await ensurePrivateDir(root);
        await writePrivateFile(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
        return next;
      }),
    appendConsent: (event) =>
      serialize(async () => {
        const events = [...(await consent()), event];
        await ensurePrivateDir(root);
        await writePrivateFile(consentFile, `${JSON.stringify({ events }, null, 2)}\n`);
      }),
  };
}
