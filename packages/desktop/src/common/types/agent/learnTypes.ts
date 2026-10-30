/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Types shared by main and renderer for "Aprender com seu trabalho".
 * Raw samples never cross the IPC: only state, exclusions and insights do.
 */

/**
 * Aprender is always on: there is no consent state and no off switch. Its use is covered by the
 * Data Notice (DATA_NOTICE_VERSION), which the employee can only acknowledge.
 */
export type LearnStatus = 'active' | 'paused' | 'unavailable';

export type LearnState = {
  status: LearnStatus;
  unavailableReason: 'encryption' | 'platform' | null;
  /** End of today's pause (in memory only); null unless status is 'paused'. */
  pausedUntil: number | null;
  /** The one pause of the local day is still unused. Once used, the control is hidden. */
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
