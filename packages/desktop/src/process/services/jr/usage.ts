import type { JrConnectionStatus, JrUsageSnapshot } from '@/common/config/clientSettings';
import { getJrRelayConfig } from './bootstrap';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withFallback(value: Record<string, unknown>, status: JrConnectionStatus): JrConnectionStatus {
  return value.fallback === true ? { ...status, fallback: true } : status;
}

/** Validate server counters without replacing unavailable token counts with zero. */
export function parseJrConnectionStatus(value: unknown): JrConnectionStatus {
  if (!record(value) || typeof value.model !== 'string' || !/^MiniMax-[A-Za-z0-9.-]+$/.test(value.model)) {
    throw new Error('Invalid reported company model');
  }
  if (value.usage === null) return withFallback(value, { connected: true, model: value.model, usage: null });
  if (!record(value.usage)) throw new Error('Invalid reported usage');
  const raw = value.usage;
  const counter = (entry: unknown): entry is number =>
    typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0;
  if (
    typeof raw.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.startedAt)) ||
    ![raw.promptTokens, raw.completionTokens, raw.cachedPromptTokens].every(
      (entry) => entry === null || counter(entry)
    ) ||
    !counter(raw.modelRequests) ||
    (typeof raw.cachedPromptTokens === 'number' &&
      typeof raw.promptTokens === 'number' &&
      raw.cachedPromptTokens > raw.promptTokens)
  )
    throw new Error('Invalid reported usage');
  const usage: JrUsageSnapshot = {
    startedAt: raw.startedAt,
    promptTokens: raw.promptTokens as number | null,
    completionTokens: raw.completionTokens as number | null,
    ...(raw.totalTokens === undefined ? {} : { totalTokens: raw.totalTokens as number | null }),
    cachedPromptTokens: raw.cachedPromptTokens as number | null,
    modelRequests: raw.modelRequests,
  };
  if (raw.totalTokens !== undefined && raw.totalTokens !== null && !counter(raw.totalTokens))
    throw new Error('Invalid reported usage');
  for (const key of ['tokensLast5h', 'tokensThisWeek'] as const) {
    if (raw[key] !== undefined) {
      if (raw[key] !== null && !counter(raw[key])) throw new Error('Invalid reported usage');
      usage[key] = raw[key] as number | null;
    }
  }
  for (const key of ['requests', 'completedRequests', 'meteredRequests', 'unmeteredRequests'] as const) {
    if (raw[key] !== undefined) {
      if (!counter(raw[key])) throw new Error('Invalid reported usage');
      usage[key] = raw[key];
    }
  }
  for (const key of ['averageLatencyMs', 'averageFirstByteMs'] as const) {
    if (raw[key] !== undefined) {
      if (raw[key] !== null && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0))
        throw new Error('Invalid reported usage');
      usage[key] = raw[key] as number | null;
    }
  }
  if (raw.lastRequestAt !== undefined) {
    if (
      raw.lastRequestAt !== null &&
      (typeof raw.lastRequestAt !== 'string' || !Number.isFinite(Date.parse(raw.lastRequestAt)))
    )
      throw new Error('Invalid reported usage');
    usage.lastRequestAt = raw.lastRequestAt as string | null;
  }
  return withFallback(value, { connected: true, model: value.model, usage });
}

export async function getJrConnectionStatus(
  env: Record<string, string | undefined> = process.env,
  request: typeof fetch = fetch
): Promise<JrConnectionStatus> {
  const config = getJrRelayConfig(env);
  if (!config) return { connected: false, model: null, usage: null };
  const response = await request(`${config.url}/jr/usage`, {
    headers: { Authorization: `Bearer ${config.token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('Company connection is unavailable');
  const parsed = parseJrConnectionStatus(await response.json());
  if (parsed.model !== config.model) throw new Error('Unexpected company model');
  return parsed;
}
