import type { JrUsageDay, JrUsageSnapshot } from '@/common/config/clientSettings';

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
 * A missing window stays null here.
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

export type UsagePeriodDays = 1 | 7 | 30;

export type UsagePeriod = {
  days: UsagePeriodDays;
  /** Null when the control server is too old to send daily history. */
  tokens: number | null;
  requests: number | null;
  /** Tokens per day over the days the person already had access inside the period. */
  averagePerDay: number | null;
  peak5h: number | null;
  peakStartedAt: string | null;
  daily: JrUsageDay[];
};

// São Paulo calendar day of an instant, matching the control service buckets.
const localDate = (iso: string): string => new Date(Date.parse(iso) - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Totals, daily average and busiest 5-hour window for the last `days` local days. */
export function usagePeriod(snapshot: JrUsageSnapshot | null | undefined, days: UsagePeriodDays): UsagePeriod {
  const empty: Omit<UsagePeriod, 'daily'> = {
    days,
    tokens: null,
    requests: null,
    averagePerDay: null,
    peak5h: null,
    peakStartedAt: null,
  };
  if (!snapshot?.daily) return { ...empty, daily: [] };
  const daily = snapshot.daily.slice(-days);
  const tokens = daily.reduce((sum, day) => sum + day.tokens, 0);
  const requests = daily.reduce((sum, day) => sum + day.requests, 0);
  const started = Number.isFinite(Date.parse(snapshot.startedAt)) ? localDate(snapshot.startedAt) : '';
  const activeDays = daily.filter((day) => day.date >= started).length;
  const peak = snapshot.peak5h?.find((entry) => entry.days === days);
  return {
    days,
    tokens,
    requests,
    averagePerDay: activeDays > 0 ? Math.round(tokens / activeDays) : null,
    peak5h: peak?.tokens ?? null,
    peakStartedAt: peak?.startedAt ?? null,
    daily,
  };
}

/** "3,4 mi" style token counts for tables and tiles. */
export function compactTokens(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
