import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applySidebarDrag,
  groupBots,
  isSectionExpanded,
  loadBotPreviews,
  PIN_ZONE_ID,
  previewFromMessages,
  pruneSidebarLayout,
  SECTION_PREFIX,
  setSectionCollapsed,
} from '@/renderer/pages/Jr/JrSidebar/groupBots';
import { readSidebarLayout, writeSidebarLayout, type KeyValueStore } from '@/renderer/pages/Jr/JrSidebar/preferences';

const bots = [
  { id: '1', name: 'Compras', workspace: '/tmp/compras' },
  { id: '2', name: 'Vendas', workspace: '/tmp/vendas' },
  { id: '3', name: 'Caixa', workspace: '/tmp/vendas' },
];

const layout = { pinnedIds: [] as string[], order: ['1', '2', '3'], collapsed: {} };

const memoryStore = (): KeyValueStore => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

describe('groupBots layout', () => {
  it('forgets pins and order entries that do not belong to a visible bot', () => {
    const orphan = 'aa67fc9c-923b-48d2-8c7a-7ec88aecdb11';
    const saved = { pinnedIds: ['3', orphan], order: [orphan, '1', '2'], collapsed: { vendas: true } };
    const next = pruneSidebarLayout(bots, saved);
    expect(next).toEqual({ pinnedIds: ['3'], order: ['1', '2'], collapsed: { vendas: true } });
    expect(pruneSidebarLayout(bots, next)).toBe(next);
  });

  it('puts saved pins above sections and keeps the saved order inside a folder', () => {
    const grouped = groupBots(bots, { pinnedIds: ['3', 'missing'], order: ['2', '1', '3'], collapsed: {} });
    expect(grouped.pinned.map((bot) => bot.id)).toEqual(['3']);
    expect(grouped.loose.map((bot) => bot.id)).toEqual(['2', '1']);
    expect(grouped.sections).toEqual([]);
  });

  it('ignores a pinned id that is not a current bot', () => {
    expect(groupBots(bots, { pinnedIds: ['gone'], order: [], collapsed: {} }).pinned).toEqual([]);
  });
});

describe('applySidebarDrag', () => {
  it('pins a bot dropped on the top zone and reorders pins by dropping on a pinned bot', () => {
    const pinned = applySidebarDrag(bots, layout, '2', PIN_ZONE_ID);
    expect(pinned.pinnedIds).toEqual(['2']);
    const reordered = applySidebarDrag(bots, { ...pinned, pinnedIds: ['2', '1'] }, '2', '1');
    expect(reordered.pinnedIds).toEqual(['1', '2']);
  });

  it('inserts an unpinned bot at the pinned row it was dropped on', () => {
    const next = applySidebarDrag(bots, { ...layout, pinnedIds: ['1', '3'] }, '2', '3');
    expect(next.pinnedIds).toEqual(['1', '2', '3']);
  });

  it('unpins a bot dropped on a user section and moves it beside that section', () => {
    const sectioned = bots.map((bot) => (bot.id === '1' ? bot : { ...bot, section: 'vendas' }));
    const next = applySidebarDrag(sectioned, { ...layout, pinnedIds: ['1'] }, '1', `${SECTION_PREFIX}vendas`);
    expect(next.pinnedIds).toEqual([]);
    expect(next.order.indexOf('1')).toBeLessThan(next.order.indexOf('2'));
  });

  it('reorders unpinned bots when one is dropped on another', () => {
    const next = applySidebarDrag(bots, layout, '3', '2');
    expect(next.pinnedIds).toEqual([]);
    expect(next.order).toEqual(['1', '3', '2']);
  });

  it('returns the same layout when the drop target is missing or the bot is unknown', () => {
    expect(applySidebarDrag(bots, layout, '1', '1')).toBe(layout);
    expect(applySidebarDrag(bots, layout, '1', 'not-a-row')).toBe(layout);
    expect(applySidebarDrag(bots, layout, 'missing', PIN_ZONE_ID)).toBe(layout);
  });
});

describe('section collapse', () => {
  it('stays collapsed unless the section contains the open bot or the user expanded it', () => {
    expect(isSectionExpanded(layout, 'vendas', false)).toBe(false);
    expect(isSectionExpanded(layout, 'compras', true)).toBe(true);
    expect(isSectionExpanded({ ...layout, collapsed: { compras: false } }, 'compras', false)).toBe(true);
  });

  it('keeps a section collapsed when the user closed it, even if its bot is open', () => {
    const closed = setSectionCollapsed(layout, 'compras', true);
    expect(isSectionExpanded(closed, 'compras', true)).toBe(false);
    expect(setSectionCollapsed(closed, 'compras', true)).toBe(closed);
  });
});

describe('previewFromMessages', () => {
  it('uses the newest visible text and collapses whitespace', () => {
    expect(
      previewFromMessages([
        { type: 'text', content: { content: 'older' } },
        { type: 'tool', content: { content: 'tool output' } },
        { type: 'text', content: { content: '  Sent   1 archive \n' } },
        { type: 'text', hidden: true, content: { content: 'hidden latest' } },
      ])
    ).toBe('Sent 1 archive');
  });

  it('returns nothing when messages are missing or not text', () => {
    expect(previewFromMessages(null)).toBe('');
    expect(previewFromMessages(undefined)).toBe('');
    expect(previewFromMessages([{ type: 'text', content: { content: '   ' } }])).toBe('');
    expect(previewFromMessages([{ hidden: true, content: 'secret' }])).toBe('');
  });
});

describe('loadBotPreviews', () => {
  it('reads one preview per conversation', async () => {
    const previews = await loadBotPreviews(
      [
        { id: '1', conversationId: 'c-1' },
        { id: '2', conversationId: null },
      ],
      async () => [{ type: 'text', content: { content: 'Salvei as 8 fotos' } }]
    );
    expect(previews).toEqual({ '1': 'Salvei as 8 fotos', '2': '' });
  });

  it('leaves the preview blank when the message read fails', async () => {
    const previews = await loadBotPreviews([{ id: '1', conversationId: 'c-1' }], async () => {
      throw new Error('offline');
    });
    expect(previews).toEqual({ '1': '' });
  });
});

describe('sidebar layout storage', () => {
  it('round-trips pins, order and collapsed sections', () => {
    const store = memoryStore();
    writeSidebarLayout({ pinnedIds: ['2', '2'], order: ['1'], collapsed: { vendas: true, bad: true } }, store);
    expect(readSidebarLayout(store)).toEqual({
      pinnedIds: ['2'],
      order: ['1'],
      collapsed: { vendas: true, bad: true },
    });
  });

  it('reads an empty layout when the saved value is not JSON or has the wrong shape', () => {
    const store = memoryStore();
    store.setItem('jr.sidebarLayout', '{');
    expect(readSidebarLayout(store)).toEqual({ pinnedIds: [], order: [], collapsed: {} });
    store.setItem(
      'jr.sidebarLayout',
      JSON.stringify({ pinnedIds: '2', order: [1, '1', '1'], collapsed: { vendas: 'yes', compras: false } })
    );
    expect(readSidebarLayout(store)).toEqual({ pinnedIds: [], order: ['1'], collapsed: { compras: false } });
  });
});

describe('sidebar row styles', () => {
  const css = readFileSync('packages/desktop/src/renderer/pages/Jr/JrSidebar/JrSidebar.module.css', 'utf8');

  it('uses a 16px name, a muted one-line preview, and the JR accent ring', () => {
    expect(css).toContain('font-size: 16px');
    expect(css).toMatch(/\.preview\s*\{[\s\S]*?color:\s*var\(--color-text-3\)/);
    expect(css).toMatch(/\.preview\s*\{[\s\S]*?white-space:\s*nowrap/);
    expect(css).toMatch(/\.botActive \.avatar\s*\{[\s\S]*?var\(--jr-accent\)/);
    expect(css).toMatch(/\.pinned\s*\{[\s\S]*?flex-direction:\s*column/);
  });

  it('keeps the bot name on the text token in both themes', () => {
    expect(css).toMatch(/\.botCopy \.botName\s*\{[\s\S]*?color:\s*var\(--color-text-1\)/);
    expect(css).not.toMatch(/\.botCopy \.botName\s*\{[\s\S]*?#fff/i);
  });
});
