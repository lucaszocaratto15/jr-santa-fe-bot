/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Dot layout of the brain drawing (viewBox 120x64), side profile. Deterministic, so renders are stable. */

export type BrainDot = {
  x: number;
  y: number;
  /** Offset the dot rises from while the brain assembles (toward the center, never far away). */
  fromX: number;
  fromY: number;
  /** Assembly delay in seconds: center first, edges last. */
  rise: number;
  /** Signal-wave delay in seconds: sweeps front to back like a nerve impulse. */
  wave: number;
};

const round = (value: number): number => Math.round(value * 10) / 10;
const jitter = (seed: number): number => {
  const raw = Math.sin(seed * 12.9898) * 43758.5453;
  return raw - Math.floor(raw);
};

export const BRAIN_CENTER = { x: 80, y: 29 } as const;

type Point = readonly [number, number];

/** Side profile facing left (front = negative x), relative to BRAIN_CENTER. */
const CEREBRUM: readonly Point[] = [
  [-24, 6],
  [-26, -2],
  [-23, -10],
  [-16, -16],
  [-6, -19],
  [4, -19],
  [13, -16],
  [20, -11],
  [25, -4],
  [25, 3],
  [20, 9],
  [11, 10],
  [3, 12],
  [-5, 13],
  [-13, 12],
  [-20, 10],
];
const CEREBELLUM: readonly Point[] = [
  [11, 12],
  [15, 16],
  [20, 15],
  [23, 11],
];
const STEM: readonly Point[] = [
  [6, 14],
  [8, 20],
];
/** Sulci: wavy grooves, not closed shapes (closed shapes read as a face). */
const SULCI: ReadonlyArray<readonly Point[]> = [
  [
    [3, -18],
    [0, -12],
    [2, -6],
    [-1, -1],
  ],
  [
    [-17, 5],
    [-9, 3],
    [-2, 5],
    [6, 1],
    [12, 3],
  ],
  [
    [-18, -7],
    [-13, -11],
    [-8, -8],
  ],
  [
    [9, -13],
    [14, -8],
    [19, -6],
  ],
];

/** Catmull-Rom through the points, then dots placed every `spacing` units along it. */
const sample = (points: readonly Point[], closed: boolean, spacing: number): Point[] => {
  const at = (i: number): Point =>
    closed ? points[(i + points.length) % points.length] : points[Math.max(0, Math.min(points.length - 1, i))];
  const dense: Point[] = [];
  const segments = closed ? points.length : points.length - 1;
  for (let i = 0; i < segments; i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let step = 0; step < 12; step += 1) {
      const t = step / 12;
      const t2 = t * t;
      const t3 = t2 * t;
      const axis = (k: 0 | 1) =>
        0.5 *
        (2 * p1[k] +
          (p2[k] - p0[k]) * t +
          (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
          (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t3);
      dense.push([axis(0), axis(1)]);
    }
  }
  if (!closed) dense.push(points[points.length - 1]);
  const result: Point[] = [dense[0]];
  let travelled = 0;
  for (let i = 1; i < dense.length; i += 1) {
    travelled += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
    if (travelled >= spacing) {
      result.push(dense[i]);
      travelled = 0;
    }
  }
  return result;
};

const shape = (): Point[] =>
  [
    ...sample(CEREBRUM, true, 3.6),
    ...sample(CEREBELLUM, false, 3),
    ...sample(STEM, false, 3),
    ...SULCI.flatMap((curve) => sample(curve, false, 4)),
  ].map(([x, y]) => [BRAIN_CENTER.x + x, BRAIN_CENTER.y + y] as const);

const points = shape();
const maxDistance = Math.max(...points.map(([x, y]) => Math.hypot(x - BRAIN_CENTER.x, y - BRAIN_CENTER.y)));
const minX = Math.min(...points.map(([x]) => x));
const width = Math.max(...points.map(([x]) => x)) - minX;

export const BRAIN_DOTS: readonly BrainDot[] = points.map(([x, y], index) => {
  const distance = Math.hypot(x - BRAIN_CENTER.x, y - BRAIN_CENTER.y) / maxDistance;
  return {
    x: round(x),
    y: round(y),
    fromX: round((BRAIN_CENTER.x - x) * 0.6),
    fromY: round((BRAIN_CENTER.y - y) * 0.6),
    rise: round(distance * 0.5 + jitter(index + 7) * 0.15),
    wave: round(((x - minX) / width) * 0.9 + jitter(index + 211) * 0.25),
  };
});

/** Where the conversation bubble sits (left) and where the bot docks next to the brain. */
export const CONVERSATION_POINT = { x: 12, y: 32 } as const;
export const BRAIN_POINT = { x: 52, y: 32 } as const;
