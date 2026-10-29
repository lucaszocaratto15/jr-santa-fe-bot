/**
 * Thresholds for blocking an employee automatically. Pure values and math only;
 * the store applies them. Owner/admin is never judged here.
 */

// Calibrated on 2026-10-29 against production usage (read-only copy, 7 days of history,
// replaying every request of every employee through volumeThreshold). With these values the
// highest observed ratio of a rolling 60-minute total to its threshold was 0.397, so no hour
// came within 50% of a block. Against a mature baseline the busiest employee's rolling hour
// reached 1.9x their own hourly p95 (a rolling hour can span two clock hours); in the first
// days, before a baseline exists, one honest hour reached about 20M tokens, which sets the floor.
/** Times the person's own hourly p95 that the last 60 minutes may reach. */
export const VOLUME_MULTIPLIER = 5;
/** Lowest threshold, used alone while an employee has no history yet. */
export const VOLUME_FLOOR_TOKENS = 50_000_000;
/** Outside-hours denials in one São Paulo day that block the employee. */
export const HOURS_DENIALS_LIMIT = 3;

/** Nearest-rank 95th percentile; 0 for an empty list. */
function p95(values) {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

/**
 * Tokens the last 60 minutes may use before an automatic block.
 * `hourlyTotals` are the person's per-hour totals (hours with usage only) of the previous 14 days.
 */
export function volumeThreshold(hourlyTotals, floor) {
  return Math.max(floor, VOLUME_MULTIPLIER * p95(hourlyTotals));
}
