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

export type UsageConsumption = {
  /** Null when the server did not report that window. */
  last5h: number | null;
  thisWeek: number | null;
  total: number | null;
};

/** Metered total from the control service, otherwise prompt + completion. */
export function reportedTokenUse(snapshot: JrUsageSnapshot | null | undefined): number {
  if (!snapshot) return 0;
  if (typeof snapshot.totalTokens === 'number' && Number.isFinite(snapshot.totalTokens)) return snapshot.totalTokens;
  if (snapshot.promptTokens == null && snapshot.completionTokens == null) return 0;
  return (snapshot.promptTokens ?? 0) + (snapshot.completionTokens ?? 0);
}

function reportedWindow(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Display-only example ceiling for both usage bars.
 * Not a quota: `TOKEN_LIMITS_ENFORCED` in services/control stays false, and nothing blocks.
 */
export const EXAMPLE_USAGE_WINDOW_TOKENS = 50_000_000;

export const USAGE_WINDOW_5H_MS = 5 * 60 * 60 * 1000;
export const USAGE_WINDOW_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type UsageReset = { hours: number; minutes: number };

export type UsageWindowView = {
  used: number;
  limit: number;
  percent: number;
  reset: UsageReset;
};

/** Time until the next fixed window boundary. A bad clock reads as 0h 0m. */
export function usageResetIn(nowMs: number, windowMs: number): UsageReset {
  if (!Number.isFinite(nowMs) || nowMs < 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    return { hours: 0, minutes: 0 };
  }
  const elapsed = ((nowMs % windowMs) + windowMs) % windowMs;
  const remainingMs = elapsed === 0 ? windowMs : windowMs - elapsed;
  const totalMinutes = Math.floor(remainingMs / 60_000);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

function displayUsed(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/** Fill against the example ceiling. Missing or invalid usage draws as an empty bar. */
export function usageWindowView(
  used: number | null | undefined,
  windowMs: number,
  nowMs: number,
  limit = EXAMPLE_USAGE_WINDOW_TOKENS
): UsageWindowView {
  const safeUsed = displayUsed(used);
  const safeLimit = displayUsed(limit);
  const percent = safeLimit <= 0 ? 0 : Math.min(100, Math.round((safeUsed / safeLimit) * 100));
  return { used: safeUsed, limit: safeLimit, percent, reset: usageResetIn(nowMs, windowMs) };
}

/**
 * Consumed tokens only. Windows come from the control service.
 * A missing window stays null here; the bars map that to an empty example fill.
 */
export function readUsageConsumption(snapshot: JrUsageSnapshot | null | undefined): UsageConsumption {
  if (!snapshot) return { last5h: 0, thisWeek: 0, total: 0 };
  const hasTotal =
    (typeof snapshot.totalTokens === 'number' && Number.isFinite(snapshot.totalTokens)) ||
    snapshot.promptTokens != null ||
    snapshot.completionTokens != null;
  return {
    last5h: reportedWindow(snapshot.tokensLast5h),
    thisWeek: reportedWindow(snapshot.tokensThisWeek),
    total: hasTotal ? reportedTokenUse(snapshot) : null,
  };
}

export type UsageBars = {
  last5h: UsageWindowView;
  week: UsageWindowView;
  total: number;
};

/** Both bars share the example ceiling. The total stays the reported figure, or zero when it is absent. */
export function usageBarsFromSnapshot(snapshot: JrUsageSnapshot | null | undefined, nowMs: number): UsageBars {
  const consumption = readUsageConsumption(snapshot);
  return {
    last5h: usageWindowView(consumption.last5h, USAGE_WINDOW_5H_MS, nowMs),
    week: usageWindowView(consumption.thisWeek, USAGE_WINDOW_WEEK_MS, nowMs),
    total: consumption.total ?? 0,
  };
}
