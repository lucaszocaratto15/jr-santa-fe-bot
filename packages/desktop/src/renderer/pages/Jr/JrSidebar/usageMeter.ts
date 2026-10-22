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
 * Consumed tokens only. Windows come from the control service.
 * There is no ceiling: a missing window stays null instead of a local quota.
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
