import { describe, expect, it } from 'vitest';
import unoConfig from '../../../uno.config';
import { groupBots, UNSECTIONED_ID, workspaceFolderLabel } from '@/renderer/pages/Jr/JrSidebar/groupBots';
import { readSpellcheck, type KeyValueStore } from '@/renderer/pages/Jr/JrSidebar/preferences';
import { setConnectorStatus } from '@/renderer/pages/Jr/JrSidebar/connectors';
import { usageMeterFromSnapshot } from '@/renderer/pages/Jr/JrSidebar/usageMeter';

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

  it('pins at most the first three bots and groups the rest by folder', () => {
    const bots = [
      { id: '1', name: 'A', workspace: 'C:\\work\\compras' },
      { id: '2', name: 'B', workspace: '/tmp/vendas' },
      { id: '3', name: 'C', workspace: '/tmp/vendas' },
      { id: '4', name: 'D', workspace: '/tmp/vendas' },
      { id: '5', name: 'E', workspace: 'D:\\' },
    ];
    const grouped = groupBots(bots);
    expect(grouped.pinned.map((bot) => bot.id)).toEqual(['1', '2', '3']);
    expect(grouped.sections).toEqual([
      { id: 'vendas', label: 'vendas', bots: [bots[3]] },
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

describe('connector mock', () => {
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
