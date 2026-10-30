/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Dot layout of the brain drawing (viewBox 120x64). Deterministic, so renders are stable. */

export type BrainDot = { x: number; y: number; fromX: number; fromY: number; delay: number };

const round = (value: number): number => Math.round(value * 10) / 10;
const jitter = (seed: number): number => {
  const raw = Math.sin(seed * 12.9898) * 43758.5453;
  return raw - Math.floor(raw);
};

const CENTER_X = 82;
const CENTER_Y = 30;
const RADIUS_X = 25;
const RADIUS_Y = 21;

const OUTLINE_POINTS = 30;
const FISSURE_POINTS = 6;
const FOLD_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-13, -6],
  [-6, -11],
  [-10, 4],
  [-3, 0],
  [13, -6],
  [6, -11],
  [10, 4],
  [3, 0],
];

const target = (): Array<readonly [number, number]> => {
  const points: Array<readonly [number, number]> = [];
  for (let i = 0; i < OUTLINE_POINTS; i += 1) {
    const angle = (i / OUTLINE_POINTS) * Math.PI * 2;
    const bump = 1 + 0.07 * Math.cos(angle * 7);
    points.push([CENTER_X + RADIUS_X * bump * Math.cos(angle), CENTER_Y + RADIUS_Y * bump * Math.sin(angle)]);
  }
  for (let i = 0; i < FISSURE_POINTS; i += 1) {
    points.push([CENTER_X + Math.sin(i * 1.3) * 1.6, CENTER_Y - 15 + i * 5.6]);
  }
  for (const [dx, dy] of FOLD_POINTS) points.push([CENTER_X + dx, CENTER_Y + dy]);
  // Brain stem.
  points.push([CENTER_X + 6, CENTER_Y + RADIUS_Y + 3], [CENTER_X + 8, CENTER_Y + RADIUS_Y + 6]);
  return points;
};

export const BRAIN_DOTS: readonly BrainDot[] = target().map(([x, y], index) => ({
  x: round(x),
  y: round(y),
  fromX: round((jitter(index + 1) - 0.5) * 70),
  fromY: round((jitter(index + 101) - 0.5) * 50),
  delay: round(jitter(index + 211) * 1.2),
}));

/** Where the conversation sits (left) and where the bot stops next to the brain. */
export const CONVERSATION_POINT = { x: 12, y: 32 } as const;
export const BRAIN_POINT = { x: 54, y: 32 } as const;
