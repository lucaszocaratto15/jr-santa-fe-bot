/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Types shared by main and renderer for "Aprender com seu trabalho".
 * Raw samples never cross the IPC: only state, exclusions and insights do.
 */

/** Work observation requires its own explicit opt-in, independent of the brain. */
export type LearnStatus = 'disabled' | 'active' | 'paused' | 'unavailable';

export type LearnState = {
  ownerId?: string | null;
  /** Earlier sampler consent does not authorize newly added real-event collectors. */
  workEventsEnabled?: boolean;
  status: LearnStatus;
  unavailableReason: 'encryption' | 'platform' | null;
  /** Kept for IPC compatibility; indefinite pauses have no deadline. */
  pausedUntil: number | null;
  /** True whenever collection can be paused. */
  pauseAvailable: boolean;
  /** macOS without Screen Recording permission → 'app-only'. */
  titles: 'full' | 'app-only';
  samplerError: boolean;
  /** Distinct sample hours on disk. */
  rawHours: number;
  lastInsightsAt: number | null;
  /** When the current 'active' stretch started (for "Aprendendo · desde 08:12"); null otherwise. */
  activeSince: number | null;
};

export type LearnExclusionKind = 'app' | 'domain' | 'title';

export type LearnExclusion = { id: string; kind: LearnExclusionKind; pattern: string; builtin: boolean };

export type LearnSample = { t: number; app: string; title: string | null; url?: string };

export type LearnSuggestion = {
  kind: 'teach' | 'tip';
  title: string;
  description: string;
  teach?: { description: string; url: string };
};

export type LearnInsightBatch = {
  ownerUserId?: string;
  id: string;
  createdAt: number;
  periodStart: number;
  periodEnd: number;
  timePerApp: Array<{ app: string; minutes: number }>;
  repetitive: Array<{ title: string; description: string; times: number; minutes: number }>;
  suggestions: LearnSuggestion[];
};

export type LearnGenerateErrorCode = 'no-data' | 'offline' | 'model-error' | 'unavailable' | 'busy';

export type LearnGenerateResult = { ok: true; batch: LearnInsightBatch } | { ok: false; code: LearnGenerateErrorCode };

export type WorkSourceType = 'erp' | 'web' | 'desktop' | 'integration' | 'manual';
export type WorkActionCategory = 'consulta' | 'exportacao' | 'preenchimento' | 'envio' | 'aprovacao' | 'outro';
export type WorkEvidence = 'strong' | 'medium' | 'weak';
export type ObservedWorkSource = 'erp.read' | 'browser.download';
export type WorkStep = { id: string; label: string; sourceType: WorkSourceType; actionCategory: WorkActionCategory };
export type WorkEvent = {
  id: string;
  eventType: 'workflow_started' | 'workflow_step_observed' | 'workflow_completed';
  sourceType: 'manual' | 'erp' | 'web';
  sourceId: 'jr-manual' | 'jr-strata' | 'jr-browser';
  actionCategory: WorkActionCategory;
  workflowKey: string;
  occurredAt: number;
  evidence: WorkEvidence;
  metadata: { systemCategory: WorkSourceType };
};
export type WorkRoutine = {
  id: string;
  name: string;
  startedAt: number;
  completedAt: number | null;
  status: 'candidate' | 'confirmed' | 'rejected';
  evidence: WorkEvidence;
  steps: WorkStep[];
  notes: string;
  inputs: string;
  outputs: string;
  eventual: boolean;
  excludedFromSummary: boolean;
  suppressSuggestion: boolean;
  /** Trusted actions prove individual steps, not an inferred business routine. */
  observed?: boolean;
  reviewedAt?: number;
};
export type WorkRoutineReview = Pick<
  WorkRoutine,
  | 'id'
  | 'name'
  | 'steps'
  | 'notes'
  | 'inputs'
  | 'outputs'
  | 'eventual'
  | 'excludedFromSummary'
  | 'suppressSuggestion'
  | 'status'
>;
export type WorkFlowState = { active: WorkRoutine | null; routines: WorkRoutine[] };
export type WorkMonthlyMap = {
  month: string;
  routines: Array<{
    name: string;
    frequency: number;
    steps: WorkStep[];
    notes: string;
    inputs: string;
    outputs: string;
    eventual: boolean;
  }>;
  pendingCount: number;
  observations: string;
};
