/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Manual da função": per-role handbook items shared through the company control server.
 * Only the employee approves an item, and approving publishes it. Admins only read.
 */

export type HandbookFrequency = 'daily' | 'weekly' | 'occasional';
export type HandbookKind = 'activity' | 'indicators';
export type HandbookSource = 'taught' | 'learn';

/** One step. `shot` is the local screenshot number; `mediaId` is the published image. */
export type HandbookStep = { text: string; shot?: number; mediaId?: string };

export type HandbookActivityBody = {
  title: string;
  description: string;
  frequency: HandbookFrequency;
  steps: HandbookStep[];
  confirmBefore: string[];
  skillName?: string;
};

export type HandbookIndicatorActivity = { title: string; timesPerWeek: number; minutesPerRun: number };
export type HandbookAppTime = { app: string; minutesPerDay: number };

export type HandbookIndicatorsBody = {
  weekStart: string;
  activities: HandbookIndicatorActivity[];
  timePerApp: HandbookAppTime[];
};

export type HandbookItem = {
  id: string;
  kind: HandbookKind;
  source: HandbookSource;
  body: HandbookActivityBody;
  approvedAt: number;
  updatedAt: number;
  media: string[];
};

/** Role indicators: averages across the role's people. Never per person. */
export type HandbookRoleIndicators = {
  activities: HandbookIndicatorActivity[];
  timePerApp: HandbookAppTime[];
  contributors: number;
};

/** Wire shape of `/handbook/mine` and `/admin/handbook/roles/:key`. No author ids or names. */
export type HandbookPayload = {
  role: { key: string; title: string } | null;
  items: HandbookItem[];
  indicators: HandbookRoleIndicators | null;
};

export type HandbookRoleSummary = { key: string; title: string; activities: number; updatedAt: number };

export type HandbookDraftBody = HandbookActivityBody | HandbookIndicatorsBody;

/** A local draft the employee may review, approve (publish) or dismiss. */
export type HandbookDraft = {
  key: string;
  kind: HandbookKind;
  source: HandbookSource;
  body: HandbookDraftBody;
  /** Screenshot numbers available for this draft (activities from taught tasks). */
  shots: number[];
  hash: string;
  publishedItemId: string | null;
  status: 'new' | 'changed';
};

/** An item this employee published, as remembered locally. */
export type HandbookPublished = { key: string; itemId: string; kind: HandbookKind; title: string };

export type HandbookError = 'no_role' | 'unavailable' | 'forbidden' | 'too_large';

/** Main → renderer: what the employee tab needs in one call. */
export type HandbookDraftsResult = {
  role: { key: string; title: string } | null;
  drafts: HandbookDraft[];
  published: HandbookPublished[];
};

/** Mermaid flowcharts built in main (the renderer does not import main code). */
export type HandbookView = HandbookPayload & {
  roleFlowchart: string;
  /** Activity item id → Mermaid source. */
  flowcharts: Record<string, string>;
};
