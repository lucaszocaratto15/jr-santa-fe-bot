import { describe, expect, it, vi } from 'vitest';
import type { LearnState } from '@/common/types/agent/learnTypes';
import { learnIndicatorReachable, learnMenuItems } from '@/process/services/teach/learn/learnMenu';

const base: LearnState = {
  status: 'off',
  unavailableReason: null,
  pausedUntil: null,
  titles: 'full',
  samplerError: false,
  rawHours: 0,
  acceptedVersion: null,
  acceptedAt: null,
  lastInsightsAt: null,
  activeSince: null,
};
const t = (key: string, opts?: Record<string, unknown>) => (opts?.time ? `${key}(${String(opts.time)})` : key);
const actions = () => ({ pause: vi.fn(), resume: vi.fn(), turnOff: vi.fn() });
const at = Date.parse('2026-10-29T12:00:00Z');
const click = (items: ReturnType<typeof learnMenuItems>, label: string) =>
  (items.find((item) => item.label === label)?.click as (() => void) | undefined)?.();

describe('learnMenuItems', () => {
  it('is empty when off, unavailable or waiting for a new consent', () => {
    for (const status of ['off', 'unavailable', 'needs-consent'] as const) {
      expect(learnMenuItems({ ...base, status }, t, actions(), 'pt-BR')).toEqual([]);
    }
    expect(learnMenuItems(null, t, actions(), 'pt-BR')).toEqual([]);
  });

  it('active: shows the 🧠 status with Pausar and Desligar', () => {
    const a = actions();
    const items = learnMenuItems({ ...base, status: 'active', activeSince: at }, t, a, 'pt-BR');
    expect(items[0]).toMatchObject({ enabled: false });
    expect(String(items[0].label)).toMatch(/^🧠 common\.jr\.learn\.indicator\.learningSince\(/);
    const labels = items.map((item) => item.label);
    expect(labels).toContain('common.jr.learn.indicator.pause1h');
    expect(labels).toContain('common.jr.learn.indicator.pauseUntilResume');
    expect(labels).toContain('common.jr.learn.indicator.turnOff');
    expect(labels).not.toContain('common.jr.learn.indicator.resume');
    click(items, 'common.jr.learn.indicator.pause1h');
    expect(a.pause).toHaveBeenCalledWith(60);
    click(items, 'common.jr.learn.indicator.pauseUntilResume');
    expect(a.pause).toHaveBeenCalledWith(null);
    click(items, 'common.jr.learn.indicator.turnOff');
    expect(a.turnOff).toHaveBeenCalled();
    expect(items.at(-1)).toEqual({ type: 'separator' });
  });

  it('paused: shows Retomar instead of Pausar', () => {
    const a = actions();
    const items = learnMenuItems({ ...base, status: 'paused', pausedUntil: null }, t, a, 'pt-BR');
    expect(items[0].label).toBe('🧠 common.jr.learn.indicator.paused');
    const labels = items.map((item) => item.label);
    expect(labels).toContain('common.jr.learn.indicator.resume');
    expect(labels).not.toContain('common.jr.learn.indicator.pause1h');
    click(items, 'common.jr.learn.indicator.resume');
    expect(a.resume).toHaveBeenCalled();
  });
});

describe('learnIndicatorReachable', () => {
  it('needs the main window on screen, the tray or a visible macOS dock', () => {
    expect(learnIndicatorReachable({ mainWindowOnScreen: true, tray: false, dockVisible: false })).toBe(true);
    expect(learnIndicatorReachable({ mainWindowOnScreen: false, tray: true, dockVisible: false })).toBe(true);
    expect(learnIndicatorReachable({ mainWindowOnScreen: false, tray: false, dockVisible: true })).toBe(true);
    expect(learnIndicatorReachable({ mainWindowOnScreen: false, tray: false, dockVisible: false })).toBe(false);
  });
});
