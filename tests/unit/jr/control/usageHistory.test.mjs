import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HISTORY_DAYS, usageHistory } from '../../../../services/control/store.mjs';

const HOUR = 3_600_000;
// 2026-10-28 15:00 in São Paulo (UTC-3).
const NOW = Date.parse('2026-10-28T18:00:00Z');

test('daily totals use São Paulo days and keep unmetered requests as requests only', () => {
  const { daily } = usageHistory(
    [
      { at: Date.parse('2026-10-28T02:30:00Z'), tokens: 100 }, // 27/10 23:30 local
      { at: Date.parse('2026-10-28T03:30:00Z'), tokens: 50 }, // 28/10 00:30 local
      { at: Date.parse('2026-10-28T10:00:00Z'), tokens: null },
    ],
    NOW
  );
  assert.equal(daily.length, HISTORY_DAYS);
  assert.deepEqual(daily.at(-1), { date: '2026-10-28', tokens: 50, requests: 2 });
  assert.deepEqual(daily.at(-2), { date: '2026-10-27', tokens: 100, requests: 1 });
  assert.equal(daily[0].date, '2026-09-29');
});

test('the 5-hour peak is the busiest rolling window inside each period', () => {
  const at = (hoursAgo) => NOW - hoursAgo * HOUR;
  const { peak5h } = usageHistory(
    [
      { at: at(72), tokens: 900 }, // three days ago: only counts for 7 and 30 days
      { at: at(71), tokens: 900 },
      { at: at(10), tokens: 300 },
      { at: at(6), tokens: 200 }, // 10h-6h ago fit one window (4h apart)
      { at: at(1), tokens: 400 }, // 6h-1h ago are 5h apart: not the same window
    ],
    NOW
  );
  assert.deepEqual(
    peak5h.map(({ days, tokens }) => [days, tokens]),
    [
      [1, 500],
      [7, 1800],
      [30, 1800],
    ]
  );
  assert.equal(peak5h[1].startedAt, new Date(at(72)).toISOString());
});
