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
  compactTokens,
  readUsageConsumption,
  reportedTokenUse,
  usageMeterFromSnapshot,
  usagePeriod,
} from '@/renderer/pages/Jr/JrSidebar/Usage/usageMeter';
import { teamUsageRows } from '@/renderer/pages/Jr/Access/TeamUsage';
import type { JrAdminEmployee, JrUsageSnapshot } from '@/common/config/clientSettings';

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
    expect(groupBots([])).toEqual({ pinned: [], loose: [], sections: [] });
  });

  it('lists bots directly until a person gives them a section', () => {
    const bots = [
      { id: '1', name: 'A', workspace: 'C:\\work\\compras' },
      { id: '2', name: 'B', workspace: '/tmp/vendas', section: 'Equipe' },
      { id: '3', name: 'C', workspace: '/tmp/vendas', section: 'Equipe' },
      { id: '4', name: 'D', workspace: '/tmp/vendas' },
      { id: '5', name: 'E', workspace: 'D:\\' },
    ];
    const grouped = groupBots(bots);
    expect(grouped.pinned).toEqual([]);
    expect(grouped.loose).toEqual([bots[0], bots[3], bots[4]]);
    expect(grouped.sections).toEqual([{ id: 'Equipe', label: 'Equipe', bots: [bots[1], bots[2]] }]);
  });

  it('treats a drive root as unsectioned', () => {
    expect(workspaceFolderLabel('C:\\')).toBe(UNSECTIONED_ID);
    expect(workspaceFolderLabel('   ')).toBe(UNSECTIONED_ID);
  });

  it('does not turn jr-workspaces into a section and still shows the named bot', () => {
    const id = 'aa67fc9c-923b-48d2-8c7a-7ec88aecdb11';
    expect(workspaceFolderLabel(`/Users/owner/Library/Application Support/jr-workspaces/${id}`)).toBe('jr-workspaces');
    const grouped = groupBots([
      { id, name: id, workspace: `/tmp/jr-workspaces/${id}` },
      {
        id: 'bot-1',
        name: 'Compras',
        workspace: `/Users/owner/Library/Application Support/JR Bot/jr-workspaces/${id}`,
      },
    ]);
    expect(grouped.loose.map((bot) => bot.name)).toEqual(['Compras']);
    expect(grouped.sections).toEqual([]);
    expect(grouped.sections.some((section) => section.label === 'jr-workspaces' || section.label === id)).toBe(false);
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

  it('hides a team titled with a raw id and keeps a team whose id is a uuid', () => {
    const id = 'aa67fc9c-923b-48d2-8c7a-7ec88aecdb11';
    const chats = teamChatsForBots(
      [
        { id, name: 'Equipe', assistants: [{ assistant_id: 'a' }, { assistant_id: 'b' }] },
        { id: 'titled-with-id', name: id, assistants: [{ assistant_id: 'a' }, { assistant_id: 'b' }] },
      ],
      new Set(['a', 'b'])
    );
    expect(chats.map((chat) => chat.id)).toEqual([id]);
  });
});

describe('usage periods', () => {
  const day = (date: string, tokens: number, requests = 1) => ({ date, tokens, requests });
  const snapshot = (startedAt: string): JrUsageSnapshot => ({
    startedAt,
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    modelRequests: 4,
    // Contiguous days like the control service sends; the 21st falls outside the last 7.
    daily: [
      day('2026-10-21', 900),
      ...['22', '23', '24', '25', '26'].map((date) => day(`2026-10-${date}`, 0, 0)),
      day('2026-10-27', 300),
      day('2026-10-28', 100, 2),
    ],
    peak5h: [
      { days: 1, tokens: 100, startedAt: '2026-10-28T12:00:00.000Z' },
      { days: 7, tokens: 300, startedAt: '2026-10-27T12:00:00.000Z' },
    ],
  });

  it('sums the last N days and averages only over days the person already had access', () => {
    const week = usagePeriod(snapshot('2026-10-27T10:00:00.000Z'), 7);
    expect(week).toMatchObject({ tokens: 400, requests: 3, averagePerDay: 200, peak5h: 300 });
    const veteran = usagePeriod(snapshot('2026-09-01T10:00:00.000Z'), 7);
    expect(veteran.averagePerDay).toBe(57);
    expect(usagePeriod(snapshot('2026-09-01T10:00:00.000Z'), 30).peak5h).toBeNull();
  });

  it('reports unknown figures for an old control server without history', () => {
    const old = usagePeriod({ ...snapshot('2026-10-27T10:00:00.000Z'), daily: undefined }, 7);
    expect(old).toMatchObject({ tokens: null, averagePerDay: null, daily: [] });
  });

  it('lists active employees by period usage, biggest first', () => {
    const person = (id: string, usage: JrUsageSnapshot | null, revoked = false) =>
      ({ id, name: id, revoked, usage }) as JrAdminEmployee;
    const light = { ...snapshot('2026-10-27T10:00:00.000Z'), daily: [day('2026-10-28', 5)] };
    const rows = teamUsageRows(
      [
        person('light', light),
        person('heavy', snapshot('2026-10-27T10:00:00.000Z')),
        person('gone', null, true),
        person('new', null),
      ],
      7
    );
    expect(rows.map((row) => row.id)).toEqual(['heavy', 'light', 'new']);
  });

  it('formats token counts compactly and keeps enforcement off', () => {
    expect(compactTokens(21_199_175, 'pt-BR')).toMatch(/^21,2\smi$/);
    expect(readFileSync('services/control/store.mjs', 'utf8')).toContain('export const TOKEN_LIMITS_ENFORCED = false');
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

describe('settings modal frame', () => {
  const css = readFileSync('packages/desktop/src/renderer/pages/Jr/JrSidebar/JrSidebar.module.css', 'utf8');
  const chrome = readFileSync('packages/desktop/src/process/utils/windowBounds.ts', 'utf8');
  const main = readFileSync('packages/desktop/src/index.ts', 'utf8');

  it('centers the nav icon and label inside the pill', () => {
    expect(css).toMatch(/\.nav \.tab:global\(\.arco-btn\.arco-btn-long\)\s*\{[^}]*align-items:\s*center/);
    expect(css).toMatch(/\.nav \.tab:global\(\.arco-btn\.arco-btn-long\)\s*\{[^}]*padding:\s*14px/);
    expect(css).toMatch(/\.tabLabel\s*\{[^}]*align-items:\s*center/);
    expect(css).toMatch(/\.tabLabel\s*\{[^}]*line-height:\s*20px/);
  });

  it('insets the macOS traffic lights inside the rounded window', () => {
    expect(chrome).toContain("titleBarStyle: 'hiddenInset'");
    expect(chrome).toContain('roundedCorners: true');
    expect(chrome).toContain('x: 20, y: 22');
  });

  it('does not keep the clipped traffic-light position', () => {
    expect(chrome).not.toContain('y: 13');
    expect(main).toContain('macTitleBarOptions');
    expect(main).toContain('setWindowButtonPosition');
    expect(main).not.toContain('trafficLightPosition: { x: 10, y: 13 }');
  });

  it('uses one JR status line and a red composer focus ring', () => {
    const jrCss = readFileSync('packages/desktop/src/renderer/styles/jr.css', 'utf8');
    const ring = readFileSync('packages/desktop/src/renderer/hooks/chat/useInputFocusRing.ts', 'utf8');
    const thought = readFileSync('packages/desktop/src/renderer/components/chat/ThoughtDisplay.tsx', 'utf8');
    expect(jrCss).toContain('.jr-working-mark');
    expect(jrCss).not.toContain('.jr-working-dots');
    expect(jrCss).toContain('--jr-composer-idle: #e4e4e4');
    expect(jrCss).toContain('--jr-composer-idle-icon: #1c1c1c');
    expect(jrCss).toContain('--jr-composer-muted-icon: #5c5c5c');
    expect(jrCss).toContain('--jr-composer-idle: #3a3a3a');
    expect(jrCss).toContain('--jr-composer-idle-icon: #f4f4f4');
    expect(jrCss).toContain('--jr-composer-muted-icon: #a3a3a3');
    expect(jrCss).toContain('stroke: var(--jr-on-accent)');
    expect(jrCss).toContain('stroke: var(--jr-composer-idle-icon)');
    expect(jrCss).toContain('stroke: var(--jr-composer-muted-icon)');
    expect(jrCss).toContain('animation: none !important');
    expect(jrCss).not.toContain('--aou-6-brand');
    expect(jrCss).not.toContain('#1e86fc');
    expect(ring).toContain('var(--jr-accent)');
    expect(ring).not.toContain('#4D4B87');
    expect(ring).not.toContain('#E1E0FF');
    expect(thought).toContain("data-testid='jr-working-mark'");
    expect(thought).not.toContain('jr-working-dots');
  });

  it('keeps the chat title in flow and the sidebar header on a two-row grid', () => {
    const chrome = readFileSync('packages/desktop/src/renderer/styles/jr.css', 'utf8');
    const layout = readFileSync('packages/desktop/src/renderer/components/layout/Layout.tsx', 'utf8');
    expect(chrome).not.toContain('top: 12px');
    expect(chrome).toContain('grid-template-columns: minmax(40px, 1fr) auto minmax(40px, 1fr)');
    expect(chrome).toContain('-webkit-app-region: no-drag');
    expect(chrome).toContain('transition: width 280ms cubic-bezier(0.22, 1, 0.36, 1)');
    expect(chrome).toContain('.jr-sider-brandline');
    expect(layout).toContain('jr.sider-collapsed');
    expect(layout).toContain('jr-sider-actions-slot');
    expect(layout).toContain("setProperty('-webkit-app-region', 'no-drag')");
    expect(layout).toContain("data-app-region='no-drag'");
  });

  it('lets the close control and the backdrop escape the window drag region', () => {
    expect(css).toMatch(/\.overlay\s*\{[^}]*-webkit-app-region:\s*no-drag/);
    expect(css).toMatch(/\.overlayMac\s*\{[^}]*padding-top:\s*56px/);
    expect(css).toMatch(/\.close:global\(\.arco-btn\)\s*\{[^}]*-webkit-app-region:\s*no-drag/);
    expect(css).toMatch(/\.windowDrag\s*\{[^}]*-webkit-app-region:\s*drag/);
  });
});
