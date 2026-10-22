import { describe, expect, it } from 'vitest';
import unoConfig from '../../../uno.config';
import {
  groupBots,
  teamChatsForBots,
  UNSECTIONED_ID,
  workspaceFolderLabel,
} from '@/renderer/pages/Jr/JrSidebar/groupBots';
import { readSpellcheck, type KeyValueStore } from '@/renderer/pages/Jr/JrSidebar/preferences';
import {
  applyLiveConnectorStatus,
  readConnectorRecords,
  setConnectorStatus,
} from '@/renderer/pages/Jr/JrSidebar/connectors';
import {
  readUsageConsumption,
  reportedTokenUse,
  usageMeterFromSnapshot,
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

describe('connector mock', () => {
  it('replaces gmail and chrome with live MCP status and leaves the other rows local', () => {
    const store = memoryStore();
    const stored = readConnectorRecords(store);
    const live = applyLiveConnectorStatus(stored, { gmail: 'disconnected', chrome: 'connected' });
    expect(live.find((item) => item.id === 'gmail')?.status).toBe('disconnected');
    expect(live.find((item) => item.id === 'chrome')?.status).toBe('connected');
    expect(live.find((item) => item.id === 'calendar')?.status).toBe('disconnected');
    expect(readConnectorRecords(store).find((item) => item.id === 'gmail')?.status).toBe('connected');
  });

  it('leaves the catalog unchanged for an unknown connector id', () => {
    const store = memoryStore();
    const before = setConnectorStatus('gmail', 'disconnected', store);
    const after = setConnectorStatus('unknown', 'connected', store);
    expect(after).toEqual(before);
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
