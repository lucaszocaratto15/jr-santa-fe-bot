/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Manual da função": per-role handbook items shared through the company control server.
 * Items publish automatically; the employee reviews afterwards (edit or hide). Admins only read.
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
  /** Active lessons of the task (texts), omitted when there are none. */
  lessons?: string[];
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
  /** True when the server left the indicators out because the caller may not see them. */
  indicatorsHidden?: boolean;
};

export type HandbookRoleSummary = { key: string; title: string; activities: number; updatedAt: number };

export type HandbookDraftBody = HandbookActivityBody | HandbookIndicatorsBody;

/** A local item (from a taught task or Aprender) as the editor opens it. */
export type HandbookDraft = {
  key: string;
  kind: HandbookKind;
  source: HandbookSource;
  body: HandbookDraftBody;
  /** Screenshot numbers available for this draft (activities from taught tasks). */
  shots: number[];
  hash: string;
  publishedItemId: string | null;
};

/** An item published for this employee. `draft` is what the editor opens (null when the source is gone). */
export type HandbookPublished = {
  key: string;
  itemId: string;
  kind: HandbookKind;
  title: string;
  draft: HandbookDraft | null;
};

/** An item the employee hid: stays hidden until its source changes. */
export type HandbookHidden = { key: string; kind: HandbookKind; title: string };

export type HandbookError = 'no_role' | 'unavailable' | 'forbidden' | 'too_large';

/** Main → renderer: what the employee tab needs in one call. */
export type HandbookDraftsResult = {
  role: { key: string; title: string } | null;
  published: HandbookPublished[];
  hidden: HandbookHidden[];
};

/** Mermaid flowcharts built in main (the renderer does not import main code). */
export type HandbookView = HandbookPayload & {
  roleFlowchart: string;
  /** Activity item id → Mermaid source. */
  flowcharts: Record<string, string>;
};
