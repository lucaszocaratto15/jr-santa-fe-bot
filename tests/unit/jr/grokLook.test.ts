import { describe, expect, it } from 'vitest';
import unoConfig from '../../../uno.config';
import {
  groupBots,
  teamChatsForBots,
  UNSECTIONED_ID,
  workspaceFolderLabel,
} from '@/renderer/pages/Jr/JrSidebar/groupBots';
import { readSpellcheck, type KeyValueStore } from '@/renderer/pages/Jr/JrSidebar/preferences';
import { readFileSync } from 'node:fs';
import {
  EXAMPLE_USAGE_WINDOW_TOKENS,
  readUsageConsumption,
  reportedTokenUse,
  USAGE_WINDOW_5H_MS,
  usageBarsFromSnapshot,
  usageMeterFromSnapshot,
  usageResetIn,
} from '@/renderer/pages/Jr/JrSidebar/usageMeter';

const memoryStore = (): KeyValueStore => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

describe('groupBots', () => {
  it('returns no pins or sections for an empty list', () => {
    expect(groupBots([])).toEqual({ pinned: [], sections: [] });
  });

  it('keeps every bot in a folder section until that bot is pinned', () => {
    const bots = [
      { id: '1', name: 'A', workspace: 'C:\\work\\compras' },
      { id: '2', name: 'B', workspace: '/tmp/vendas' },
      { id: '3', name: 'C', workspace: '/tmp/vendas' },
      { id: '4', name: 'D', workspace: '/tmp/vendas' },
      { id: '5', name: 'E', workspace: 'D:\\' },
    ];
    const grouped = groupBots(bots);
    expect(grouped.pinned).toEqual([]);
    expect(grouped.sections).toEqual([
      { id: 'compras', label: 'compras', bots: [bots[0]] },
      { id: 'vendas', label: 'vendas', bots: [bots[1], bots[2], bots[3]] },
      { id: UNSECTIONED_ID, label: UNSECTIONED_ID, bots: [bots[4]] },
    ]);
  });

  it('treats a drive root as unsectioned', () => {
    expect(workspaceFolderLabel('C:\\')).toBe(UNSECTIONED_ID);
    expect(workspaceFolderLabel('   ')).toBe(UNSECTIONED_ID);
  });
});

describe('usageMeterFromSnapshot', () => {
  it('returns an empty meter when nothing was reported', () => {
    expect(usageMeterFromSnapshot(null).inputSharePercent).toBeNull();
    expect(usageMeterFromSnapshot(undefined).requests).toBe(0);
  });

  it('uses the input share of reported tokens', () => {
    const meter = usageMeterFromSnapshot({
      promptTokens: 25,
      completionTokens: 75,
      cachedPromptTokens: 0,
      modelRequests: 2,
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(meter.inputSharePercent).toBe(25);
    expect(meter.requests).toBe(2);
  });
});

describe('readUsageConsumption', () => {
  it('shows zero consumption when nothing was reported', () => {
    expect(readUsageConsumption(null)).toEqual({ last5h: 0, thisWeek: 0, total: 0 });
    expect(readUsageConsumption(undefined)).toEqual({ last5h: 0, thisWeek: 0, total: 0 });
  });

  it('uses reported windows and the metered total without a ceiling', () => {
    const snapshot = {
      promptTokens: 40,
      completionTokens: 10,
      totalTokens: 15,
      tokensLast5h: 6,
      tokensThisWeek: 15,
      cachedPromptTokens: 0,
      modelRequests: 1,
      startedAt: '2026-10-22T14:00:00.000Z',
    };
    expect(reportedTokenUse(snapshot)).toBe(15);
    expect(readUsageConsumption(snapshot)).toEqual({ last5h: 6, thisWeek: 15, total: 15 });
  });

  it('leaves a missing window unreported instead of inventing a limit', () => {
    const snapshot = {
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: null,
      cachedPromptTokens: 0,
      modelRequests: 1,
      startedAt: '2026-10-22T14:00:00.000Z',
    };
    expect(reportedTokenUse(snapshot)).toBe(10);
    expect(readUsageConsumption(snapshot)).toEqual({ last5h: null, thisWeek: null, total: 10 });
  });
});

describe('teamChatsForBots', () => {
  it('keeps only teams whose members are all listed bots', () => {
    const chats = teamChatsForBots(
      [
        { id: 'ok', assistants: [{ assistant_id: 'a' }, { assistant_id: 'b' }] },
        { id: 'short', assistants: [{ assistant_id: 'a' }] },
        { id: 'stranger', assistants: [{ assistant_id: 'a' }, { assistant_id: 'missing' }] },
        { id: 'empty', assistants: [] },
      ],
      new Set(['a', 'b'])
    );
    expect(chats.map((chat) => chat.id)).toEqual(['ok']);
  });
});

describe('usage bars', () => {
  const now = USAGE_WINDOW_5H_MS + 90 * 60 * 1000;

  it('fills both windows from reported usage against the example ceiling', () => {
    const bars = usageBarsFromSnapshot(
      {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        tokensLast5h: 25_000_000,
        tokensThisWeek: 10_000_000,
        cachedPromptTokens: 0,
        modelRequests: 1,
        startedAt: '2026-10-22T14:00:00.000Z',
      },
      now
    );
    expect(bars.last5h).toMatchObject({ used: 25_000_000, limit: EXAMPLE_USAGE_WINDOW_TOKENS, percent: 50 });
    expect(bars.week).toMatchObject({ used: 10_000_000, limit: EXAMPLE_USAGE_WINDOW_TOKENS, percent: 20 });
    expect(bars.total).toBe(15);
    expect(bars.last5h.reset).toEqual({ hours: 3, minutes: 30 });
  });

  it('draws a missing window as empty and caps the bar at 100 percent', () => {
    const bars = usageBarsFromSnapshot(
      {
        promptTokens: 4,
        completionTokens: 6,
        totalTokens: null,
        tokensLast5h: null,
        tokensThisWeek: EXAMPLE_USAGE_WINDOW_TOKENS + 1,
        cachedPromptTokens: 0,
        modelRequests: 1,
        startedAt: '2026-10-22T14:00:00.000Z',
      },
      now
    );
    expect(bars.last5h.used).toBe(0);
    expect(bars.last5h.percent).toBe(0);
    expect(bars.week.percent).toBe(100);
    expect(bars.week.used).toBe(EXAMPLE_USAGE_WINDOW_TOKENS + 1);
  });

  it('reads a bad clock as zero remaining and keeps enforcement off', () => {
    expect(usageResetIn(Number.NaN, USAGE_WINDOW_5H_MS)).toEqual({ hours: 0, minutes: 0 });
    expect(usageResetIn(-1, USAGE_WINDOW_5H_MS)).toEqual({ hours: 0, minutes: 0 });
    const source = readFileSync('services/control/store.mjs', 'utf8');
    expect(source).toContain('export const TOKEN_LIMITS_ENFORCED = false');
    expect(
      readFileSync('packages/desktop/src/renderer/pages/Jr/JrSidebar/usageMeter.ts', 'utf8').match(/50_000_000/g)
    ).toEqual(['50_000_000']);
  });
});

describe('spellcheck preference', () => {
  it('defaults to enabled when nothing is stored', () => {
    expect(readSpellcheck(memoryStore())).toBe(true);
  });
});

describe('accent token', () => {
  it('exposes bg-accent as the accent CSS variable', () => {
    const colors = (unoConfig.theme as { colors?: Record<string, string> } | undefined)?.colors;
    expect(colors?.accent).toBe('var(--accent)');
  });
});
