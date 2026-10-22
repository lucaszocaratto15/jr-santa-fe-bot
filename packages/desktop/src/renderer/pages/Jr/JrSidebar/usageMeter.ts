import type { JrUsageSnapshot } from '@/common/config/clientSettings';

export type UsageMeter = {
  inputTokens: number | null;
  outputTokens: number | null;
  requests: number;
  startedAt: string | null;
  /** Share of reported tokens that are input, 0–100. Null when nothing was reported. */
  inputSharePercent: number | null;
};

/**
 * The usage payload has token and request counters plus `startedAt`.
 * It does not include a weekly quota or a reset instant, so the bar is the
 * input share of reported tokens rather than a subscription limit.
 */
export function usageMeterFromSnapshot(snapshot: JrUsageSnapshot | null | undefined): UsageMeter {
  if (!snapshot) {
    return { inputTokens: null, outputTokens: null, requests: 0, startedAt: null, inputSharePercent: null };
  }
  const input = snapshot.promptTokens;
  const output = snapshot.completionTokens;
  const total = (input ?? 0) + (output ?? 0);
  const inputSharePercent = input != null && output != null && total > 0 ? Math.round((input / total) * 100) : null;
  return {
    inputTokens: input,
    outputTokens: output,
    requests: snapshot.modelRequests ?? 0,
    startedAt: snapshot.startedAt || null,
    inputSharePercent,
  };
}

/** Mock ceilings until gateway `/mmx/me/usage` is on the desktop bridge. */
export const WINDOW_5H_LIMIT = 3_000_000;
export const WEEKLY_LIMIT = 15_000_000;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type UsageWindowQuota = {
  used: number;
  limit: number;
  resetAt: string;
};

export type UsageQuota = {
  window5h: UsageWindowQuota;
  weekly: UsageWindowQuota;
  /**
   * Always `mock` today. `used` is mapped from reported tokens when a snapshot
   * exists. Limits and reset times are not on `JrUsageSnapshot`.
   * Codex: replace this reader with gateway `/mmx/me/usage`.
   */
  source: 'mock';
};

/** Metered total from the control service, otherwise prompt + completion. */
export function reportedTokenUse(snapshot: JrUsageSnapshot | null | undefined): number {
  if (!snapshot) return 0;
  if (typeof snapshot.totalTokens === 'number' && Number.isFinite(snapshot.totalTokens)) return snapshot.totalTokens;
  if (snapshot.promptTokens == null && snapshot.completionTokens == null) return 0;
  return (snapshot.promptTokens ?? 0) + (snapshot.completionTokens ?? 0);
}

function nextBoundary(now: number, windowMs: number, anchorMs: number): string {
  const anchor = Number.isFinite(anchorMs) ? anchorMs : now;
  const elapsed = now - anchor;
  const steps = elapsed >= 0 ? Math.floor(elapsed / windowMs) + 1 : 1;
  return new Date(anchor + steps * windowMs).toISOString();
}

/**
 * Quota cards for the usage tab.
 * `used` is the control-service total when `totalTokens` is present, otherwise
 * prompt + completion. The 3M / 15M ceilings and renewal instants stay mocked:
 * `JrUsageSnapshot` has no 5-hour or weekly window.
 */
export function readUsageQuota(snapshot: JrUsageSnapshot | null | undefined, now = Date.now()): UsageQuota {
  const used = reportedTokenUse(snapshot);
  const anchor = snapshot?.startedAt ? Date.parse(snapshot.startedAt) : now;
  return {
    window5h: { used, limit: WINDOW_5H_LIMIT, resetAt: nextBoundary(now, FIVE_HOURS_MS, anchor) },
    weekly: { used, limit: WEEKLY_LIMIT, resetAt: nextBoundary(now, WEEK_MS, anchor) },
    source: 'mock',
  };
}

export function quotaPercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

/** JR red up to 80% used, amber after that. */
export function quotaTone(percent: number): 'accent' | 'amber' {
  return percent > 80 ? 'amber' : 'accent';
}

export function renewalParts(resetAt: string, now = Date.now()): { days: number; hours: number; minutes: number } {
  const target = Date.parse(resetAt);
  const remaining = Math.max(0, (Number.isFinite(target) ? target : now) - now);
  const minutesTotal = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutesTotal / (60 * 24));
  const hours = Math.floor((minutesTotal - days * 24 * 60) / 60);
  const minutes = minutesTotal - days * 24 * 60 - hours * 60;
  return { days, hours, minutes };
}
