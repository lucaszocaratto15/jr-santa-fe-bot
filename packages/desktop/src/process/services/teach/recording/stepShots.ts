/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-step screenshots of a teach recording ("telas"). A shot is taken a short delay after a
 * click, submit or navigation, and is skipped whenever the step may show a secret. The
 * decision is checked again right before and right after the capture, so a vault fill during
 * the delay still skips it. Images stay on disk: only `[tela N]` markers ever reach the model.
 */

export type ShotSkipReason = 'secret-event' | 'secret-dirty' | 'live-secret' | 'limit';
export type ShotDecision = { take: true } | { take: false; reason: ShotSkipReason };

export const SHOT_DELAY_MS = 800;
export const SHOT_MAX_BYTES = 300 * 1024;
export const MAX_SHOTS = 40;
export const SHOT_MAX_WIDTH = 1280;
const QUALITIES = [60, 40] as const;

/** Whether a step may be photographed. Secrets win over everything else. */
export function decideShot(input: {
  eventSecret: boolean;
  secretDirty: boolean;
  liveSecret: boolean;
  taken: number;
  max: number;
}): ShotDecision {
  if (input.eventSecret) return { take: false, reason: 'secret-event' };
  if (input.secretDirty) return { take: false, reason: 'secret-dirty' };
  if (input.liveSecret) return { take: false, reason: 'live-secret' };
  if (input.taken >= input.max) return { take: false, reason: 'limit' };
  return { take: true };
}

export type ShotTakerDeps = {
  /** Raw JPEG of the attached page, or null when it cannot be captured. */
  capture: () => Promise<Buffer | null>;
  /** Re-encode (and shrink to SHOT_MAX_WIDTH) at a JPEG quality; null when it fails. */
  encode: (jpeg: Buffer, quality: number) => Buffer | null;
  write: (n: number, data: Buffer) => Promise<void>;
  delayMs?: number;
  maxBytes?: number;
};

export type ShotTaker = {
  /** Schedule a shot for an event. A newer schedule within the delay replaces the pending one. */
  schedule(eventIndex: number, decide: () => ShotDecision): void;
  /** Shots written so far. */
  count(): number;
  /** Take a still pending shot now and wait for every write. Maps event index → shot number. */
  flush(): Promise<Map<number, number>>;
};

export function createShotTaker(deps: ShotTakerDeps): ShotTaker {
  const delayMs = deps.delayMs ?? SHOT_DELAY_MS;
  const maxBytes = deps.maxBytes ?? SHOT_MAX_BYTES;
  const results = new Map<number, number>();
  let taken = 0;
  let pending: { eventIndex: number; decide: () => ShotDecision; timer: ReturnType<typeof setTimeout> } | null = null;
  let chain: Promise<void> = Promise.resolve();

  const encodeWithinLimit = (raw: Buffer): Buffer | null => {
    for (const quality of QUALITIES) {
      const out = deps.encode(raw, quality);
      if (out && out.length <= maxBytes) return out;
    }
    return null;
  };

  const shoot = async (eventIndex: number, decide: () => ShotDecision) => {
    if (!decide().take) return;
    const raw = await deps.capture().catch((): null => null);
    // A secret may have appeared while the capture was in flight: drop the image.
    if (!raw || !decide().take) return;
    const out = encodeWithinLimit(raw);
    if (!out) return;
    const n = taken + 1;
    await deps.write(n, out);
    taken = n;
    results.set(eventIndex, n);
  };

  const run = () => {
    const current = pending;
    pending = null;
    if (!current) return;
    clearTimeout(current.timer);
    chain = chain.then(() => shoot(current.eventIndex, current.decide)).catch(() => {});
  };

  return {
    schedule(eventIndex, decide) {
      if (pending) clearTimeout(pending.timer);
      pending = { eventIndex, decide, timer: setTimeout(run, delayMs) };
    },
    count: () => taken,
    async flush() {
      run();
      await chain;
      return new Map(results);
    },
  };
}

const SHOT_REF_RE = /\[tela (\d{1,3})\]/g;

/** Shot numbers cited by `[tela N]` markers, in order of first appearance, without repeats. */
export function extractShotRefs(markdown: string): number[] {
  const seen = new Set<number>();
  for (const match of markdown.matchAll(SHOT_REF_RE)) {
    const n = Number(match[1]);
    if (n > 0) seen.add(n);
  }
  return [...seen];
}
