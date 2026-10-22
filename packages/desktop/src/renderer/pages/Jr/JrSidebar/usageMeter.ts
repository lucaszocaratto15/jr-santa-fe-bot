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
