/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Control-server client of the "Manual da função". Every response is shape-checked, and
 * errors are reduced to a HandbookError code. The JR session token stays in main.
 */

import type {
  HandbookActivityBody,
  HandbookAppTime,
  HandbookError,
  HandbookIndicatorActivity,
  HandbookItem,
  HandbookKind,
  HandbookPayload,
  HandbookRoleIndicators,
  HandbookRoleSummary,
  HandbookSource,
  HandbookStep,
} from '@/common/types/agent/handbookTypes';

export type HandbookCall = (path: string, init?: RequestInit, admin?: boolean) => Promise<unknown>;

export type HandbookPublishInput = {
  id: string;
  kind: HandbookKind;
  source: HandbookSource;
  body: object;
  media: Array<{ id: string; base64: string }>;
};

export type HandbookClient = {
  mine(): Promise<HandbookPayload>;
  publish(input: HandbookPublishInput): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
  withdrawLearn(): Promise<void>;
  media(id: string): Promise<{ mime: string; base64: string }>;
  adminRoles(): Promise<HandbookRoleSummary[]>;
  adminRole(key: string): Promise<HandbookPayload>;
};

const PUBLISH_TIMEOUT_MS = 120_000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Map a controller error onto the four handbook error codes. */
export function handbookErrorCode(error: unknown): HandbookError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'JR_HANDBOOK_NO_ROLE' || message === 'no_role') return 'no_role';
  if (message === 'JR_ACCESS_FORBIDDEN' || message === 'forbidden') return 'forbidden';
  if (message === 'JR_HANDBOOK_TOO_LARGE' || message === 'too_large') return 'too_large';
  return 'unavailable';
}

const invalid = (): never => {
  throw new Error('unavailable');
};

function parseStep(value: unknown): HandbookStep {
  if (!record(value) || !text(value.text, 4000)) return invalid();
  const step: HandbookStep = { text: value.text };
  if (value.mediaId !== undefined) {
    if (typeof value.mediaId !== 'string' || !ID_RE.test(value.mediaId)) return invalid();
    step.mediaId = value.mediaId;
  }
  return step;
}

function parseActivity(value: unknown): HandbookActivityBody {
  if (
    !record(value) ||
    !text(value.title, 200) ||
    !text(value.description, 4000) ||
    (value.frequency !== 'daily' && value.frequency !== 'weekly' && value.frequency !== 'occasional') ||
    !Array.isArray(value.steps) ||
    !Array.isArray(value.confirmBefore) ||
    !value.confirmBefore.every((entry) => text(entry, 400))
  ) {
    return invalid();
  }
  return {
    title: value.title,
    description: value.description,
    frequency: value.frequency,
    steps: value.steps.map(parseStep),
    confirmBefore: value.confirmBefore as string[],
    ...(text(value.skillName, 80) ? { skillName: value.skillName } : {}),
  };
}

function parseItem(value: unknown): HandbookItem | null {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !ID_RE.test(value.id) ||
    (value.source !== 'taught' && value.source !== 'learn') ||
    !count(value.approvedAt) ||
    !count(value.updatedAt) ||
    !Array.isArray(value.media) ||
    !value.media.every((id) => typeof id === 'string' && ID_RE.test(id))
  ) {
    return invalid();
  }
  // Only activities are shown; a newer server could add other kinds.
  if (value.kind !== 'activity') return null;
  return {
    id: value.id,
    kind: 'activity',
    source: value.source,
    body: parseActivity(value.body),
    approvedAt: value.approvedAt,
    updatedAt: value.updatedAt,
    media: value.media as string[],
  };
}

function parseIndicators(value: unknown): HandbookRoleIndicators | null {
  if (value === null) return null;
  if (
    !record(value) ||
    !Array.isArray(value.activities) ||
    !Array.isArray(value.timePerApp) ||
    !count(value.contributors)
  )
    return invalid();
  const activities: HandbookIndicatorActivity[] = value.activities.map((entry) => {
    if (!record(entry) || !text(entry.title, 200) || !count(entry.timesPerWeek) || !count(entry.minutesPerRun))
      return invalid();
    return { title: entry.title, timesPerWeek: entry.timesPerWeek, minutesPerRun: entry.minutesPerRun };
  });
  const timePerApp: HandbookAppTime[] = value.timePerApp.map((entry) => {
    if (!record(entry) || !text(entry.app, 200) || !count(entry.minutesPerDay)) return invalid();
    return { app: entry.app, minutesPerDay: entry.minutesPerDay };
  });
  return { activities, timePerApp, contributors: value.contributors };
}

/** Validate `/handbook/mine` or `/admin/handbook/roles/:key`. Throws `unavailable` on a bad shape. */
export function parseHandbookPayload(value: unknown): HandbookPayload {
  if (!record(value) || !Array.isArray(value.items)) return invalid();
  let role: HandbookPayload['role'] = null;
  if (value.role !== null) {
    if (!record(value.role) || !text(value.role.key, 120) || !text(value.role.title, 80)) return invalid();
    role = { key: value.role.key, title: value.role.title };
  }
  return {
    role,
    items: value.items.map(parseItem).filter((item): item is HandbookItem => item !== null),
    indicators: parseIndicators(value.indicators ?? null),
  };
}

export function createHandbookClient(call: HandbookCall): HandbookClient {
  const guarded = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      throw new Error(handbookErrorCode(error), { cause: error });
    }
  };
  return {
    mine: () => guarded(async () => parseHandbookPayload(await call('/handbook/mine'))),
    publish: (input) =>
      guarded(async () => {
        const value = await call('/handbook/items', {
          method: 'POST',
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
        });
        if (!record(value) || value.id !== input.id) return invalid();
        return { id: input.id };
      }),
    remove: (id) =>
      guarded(async () => {
        if (!ID_RE.test(id)) return invalid();
        await call(`/handbook/items/${id}`, { method: 'DELETE' });
      }),
    withdrawLearn: () =>
      guarded(async () => {
        await call('/handbook/withdraw-learn', { method: 'POST' });
      }),
    media: (id) =>
      guarded(async () => {
        if (!ID_RE.test(id)) return invalid();
        const value = await call(`/handbook/media/${id}`);
        if (!record(value) || value.mime !== 'image/jpeg' || typeof value.base64 !== 'string') return invalid();
        return { mime: value.mime, base64: value.base64 };
      }),
    adminRoles: () =>
      guarded(async () => {
        const value = await call('/admin/handbook/roles', {}, true);
        if (!record(value) || !Array.isArray(value.roles)) return invalid();
        return value.roles.map((entry): HandbookRoleSummary => {
          if (!record(entry) || !text(entry.key, 120) || !text(entry.title, 80) || !count(entry.activities))
            return invalid();
          return {
            key: entry.key,
            title: entry.title,
            activities: entry.activities,
            updatedAt: count(entry.updatedAt) ? entry.updatedAt : 0,
          };
        });
      }),
    adminRole: (key) =>
      guarded(async () =>
        parseHandbookPayload(await call(`/admin/handbook/roles/${encodeURIComponent(key)}`, {}, true))
      ),
  };
}
