/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure builders of "Manual da função" drafts: a taught task becomes an activity, and the
 * Aprender insight batches become observed activities and the weekly indicators. No I/O.
 */

import { createHash } from 'node:crypto';
import type {
  HandbookActivityBody,
  HandbookFrequency,
  HandbookIndicatorsBody,
  HandbookStep,
} from '@/common/types/agent/handbookTypes';
import type { LearnInsightBatch } from '@/common/types/agent/learnTypes';
import type { TaughtTaskContent } from '@/common/types/agent/teachTypes';
import { parseDraft } from '../recording/skillDraft';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MAX_TITLE = 120;
const SHOT_MARKER_RE = /\s*\[tela (\d{1,3})\]/g;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Lower case, no accents, single spaces: groups the same activity seen on different days. */
export const normalizeTitle = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');

const shortTitle = (value: string): string => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
};

/**
 * Activity draft of a taught task. Steps come from `## Passos`; each `[tela N]` marker becomes
 * the step's `shot` (the first one whose file exists) and is removed from the text.
 */
export function activityFromSkill(
  task: TaughtTaskContent,
  shotsAvailable: number[]
): HandbookActivityBody & { shots: number[] } {
  const markdown = `---\nname: ${task.name}\ndescription: ${JSON.stringify(task.description)}\n---\n${task.body}`;
  const parsed = parseDraft(markdown);
  const available = new Set(shotsAvailable);
  const used: number[] = [];
  const steps: HandbookStep[] = (parsed.ok ? parsed.steps : []).map((raw) => {
    const cited = [...raw.matchAll(SHOT_MARKER_RE)].map((match) => Number(match[1]));
    const shot = cited.find((n) => available.has(n));
    const text = raw.replace(SHOT_MARKER_RE, '').trim();
    if (shot === undefined) return { text };
    used.push(shot);
    return { text, shot };
  });
  return {
    title: shortTitle(task.description),
    description: task.description.trim(),
    frequency: 'occasional',
    steps,
    confirmBefore: parsed.ok ? parsed.confirmBefore : [],
    skillName: task.name,
    shots: [...new Set(used)],
  };
}

const frequencyOf = (timesPerWeek: number): HandbookFrequency => {
  if (timesPerWeek >= 5) return 'daily';
  if (timesPerWeek >= 1) return 'weekly';
  return 'occasional';
};

type Grouped = { title: string; description: string; times: number; minutes: number };

/** Sum the repetitive items of the batches per normalized title (times are per day per batch). */
function groupRepetitive(batches: LearnInsightBatch[]): Grouped[] {
  const groups = new Map<string, Grouped>();
  for (const batch of batches) {
    for (const item of batch.repetitive) {
      const title = item.title.trim();
      if (!title) continue;
      const key = normalizeTitle(title);
      const group = groups.get(key) ?? { title, description: item.description.trim(), times: 0, minutes: 0 };
      group.times += item.times;
      group.minutes += item.minutes;
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

/** Observed activities from the given (recent) insight batches. */
export function activitiesFromInsights(batches: LearnInsightBatch[]): HandbookActivityBody[] {
  return groupRepetitive(batches).map(
    (group): HandbookActivityBody => ({
      title: shortTitle(group.title),
      description: group.description,
      frequency: frequencyOf(group.times),
      steps: [],
      confirmBefore: [],
    })
  );
}

/** Batches created in the 7 days up to `now`. */
export const recentBatches = (batches: LearnInsightBatch[], now: number): LearnInsightBatch[] =>
  batches.filter((batch) => batch.createdAt > now - WEEK_MS && batch.createdAt <= now);

/** Monday (UTC) of the week containing `now`, as YYYY-MM-DD: the key of the weekly draft. */
export function weekStartOf(now: number): string {
  const date = new Date(now);
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - sinceMonday))
    .toISOString()
    .slice(0, 10);
}

/** This employee's indicators of the last 7 days, or null without insight batches. */
export function weeklyIndicators(batches: LearnInsightBatch[], now: number): HandbookIndicatorsBody | null {
  const recent = recentBatches(batches, now);
  if (recent.length === 0) return null;
  const apps = new Map<string, { app: string; minutes: number }>();
  for (const batch of recent) {
    for (const entry of batch.timePerApp) {
      const key = normalizeTitle(entry.app);
      if (!key) continue;
      const current = apps.get(key) ?? { app: entry.app.trim(), minutes: 0 };
      current.minutes += entry.minutes;
      apps.set(key, current);
    }
  }
  return {
    weekStart: weekStartOf(now),
    activities: groupRepetitive(recent).map((group) => ({
      title: shortTitle(group.title),
      timesPerWeek: round1(group.times),
      minutesPerRun: group.times > 0 ? round1(group.minutes / group.times) : 0,
    })),
    timePerApp: [...apps.values()].map((entry) => ({
      app: entry.app,
      minutesPerDay: round1(entry.minutes / recent.length),
    })),
  };
}

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .toSorted()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])])
    );
  }
  return value;
};

/** sha256 of the stable JSON of a draft source: an unchanged source keeps its hash. */
export function draftHash(body: unknown, shots: number[]): string {
  return createHash('sha256')
    .update(JSON.stringify(stable({ body, shots })))
    .digest('hex');
}
