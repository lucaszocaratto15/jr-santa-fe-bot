import { describe, expect, it } from 'vitest';
import { parseJrConnectionStatus } from '@process/services/jr/usage';

const base = {
  startedAt: '2026-10-22T14:00:00.000Z',
  promptTokens: 10,
  completionTokens: 5,
  cachedPromptTokens: 0,
  modelRequests: 1,
};

describe('parseJrConnectionStatus usage history', () => {
  it('keeps daily history and 5-hour peaks from the control service', () => {
    const status = parseJrConnectionStatus({
      model: 'MiniMax-M3.1-Flash',
      usage: {
        ...base,
        daily: [{ date: '2026-10-28', tokens: 15, requests: 1, extra: 'dropped' }],
        peak5h: [{ days: 7, tokens: 15, startedAt: '2026-10-28T12:00:00.000Z' }],
      },
    });
    expect(status.usage?.daily).toEqual([{ date: '2026-10-28', tokens: 15, requests: 1 }]);
    expect(status.usage?.peak5h).toEqual([{ days: 7, tokens: 15, startedAt: '2026-10-28T12:00:00.000Z' }]);
  });

  it('accepts an older server without history and rejects malformed history', () => {
    expect(parseJrConnectionStatus({ model: 'MiniMax-M3.1-Flash', usage: base }).usage?.daily).toBeUndefined();
    expect(() =>
      parseJrConnectionStatus({
        model: 'MiniMax-M3.1-Flash',
        usage: { ...base, daily: [{ date: 'ontem', tokens: 1, requests: 1 }] },
      })
    ).toThrow('Invalid reported usage');
    expect(() =>
      parseJrConnectionStatus({
        model: 'MiniMax-M3.1-Flash',
        usage: { ...base, peak5h: [{ days: 7, tokens: -1, startedAt: null }] },
      })
    ).toThrow('Invalid reported usage');
  });
});
