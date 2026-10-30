/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MenuItemConstructorOptions } from 'electron';
import type { LearnState } from '@/common/types/agent/learnTypes';
import type { LearnService } from './learnService';

export type LearnMenuActions = {
  pause: (minutes: number | null) => void;
  resume: () => void;
  turnOff: () => void;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * 🧠 entries for the tray and macOS dock menus, so the status and Pausar/Desligar stay
 * reachable when no JR window is on screen. Empty unless "Aprender" is on (active or paused).
 */
export function learnMenuItems(
  state: LearnState | null,
  t: Translate,
  actions: LearnMenuActions,
  locale: string
): MenuItemConstructorOptions[] {
  if (!state || (state.status !== 'active' && state.status !== 'paused')) return [];
  const time = (at: number) => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
  const active = state.status === 'active';
  const status = active
    ? state.activeSince
      ? t('common.jr.learn.indicator.learningSince', { time: time(state.activeSince) })
      : t('common.jr.learn.indicator.learning')
    : state.pausedUntil
      ? t('common.jr.learn.indicator.pausedUntil', { time: time(state.pausedUntil) })
      : t('common.jr.learn.indicator.paused');
  const controls: MenuItemConstructorOptions[] = active
    ? [
        { label: t('common.jr.learn.indicator.pause1h'), click: () => actions.pause(60) },
        { label: t('common.jr.learn.indicator.pauseUntilResume'), click: () => actions.pause(null) },
      ]
    : [{ label: t('common.jr.learn.indicator.resume'), click: () => actions.resume() }];
  return [
    { label: `🧠 ${status}`, enabled: false },
    ...controls,
    { label: t('common.jr.learn.indicator.turnOff'), click: () => actions.turnOff() },
    { type: 'separator' },
  ];
}

/** Sampling needs a reachable 🧠: the main window on screen, the tray icon or the macOS dock. */
export function learnIndicatorReachable(where: {
  mainWindowOnScreen: boolean;
  tray: boolean;
  dockVisible: boolean;
}): boolean {
  return where.mainWindowOnScreen || where.tray || where.dockVisible;
}

const run = (action: () => Promise<unknown>): void => void action().catch(() => {});

/** The 🧠 entries wired to the running service; errors are swallowed (the panel reports them). */
export function learnServiceMenuItems(
  service: LearnService | null,
  t: Translate,
  locale: string
): MenuItemConstructorOptions[] {
  if (!service) return [];
  return learnMenuItems(
    service.state(),
    t,
    {
      pause: (minutes) => run(() => service.pause(minutes)),
      resume: () => run(() => service.resume()),
      turnOff: () => run(() => service.turnOff()),
    },
    locale
  );
}
