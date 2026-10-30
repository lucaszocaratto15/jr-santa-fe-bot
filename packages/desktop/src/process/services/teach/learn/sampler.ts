/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { samplerCommand } from './samplerScripts';

export type ForegroundSample = { app: string; title: string | null };

export type Sampler = {
  /** One request/response round trip. null = no usable sample (failure, timeout, stopped). */
  sample(): Promise<ForegroundSample | null>;
  /** Kills the child; later calls resolve null without spawning. */
  stop(): void;
  /** 3 failures within 10 minutes: the sampler gives up for good, until it is recreated. */
  failed(): boolean;
};

export type SamplerDeps = {
  spawn: typeof nodeSpawn;
  platform: NodeJS.Platform;
  now: () => number;
  timeoutMs?: number;
  /** First reply after a spawn: PowerShell `Add-Type` compiles C# and antivirus may scan it. */
  firstTimeoutMs?: number;
};

export const SAMPLER_TIMEOUT_MS = 5_000;
export const SAMPLER_FIRST_TIMEOUT_MS = 30_000;
const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 3;
const MAX_FIELD = 300;

const parseObject = (line: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(line.replace(/^﻿/, '').trim());
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** Validate one child reply line. */
export function parseSampleLine(line: string): ForegroundSample | null {
  const value = parseObject(line);
  if (!value || typeof value.app !== 'string') return null;
  if (value.title !== null && value.title !== undefined && typeof value.title !== 'string') return null;
  const app = value.app.trim().slice(0, MAX_FIELD);
  if (!app) return null;
  const title = typeof value.title === 'string' ? value.title.trim().slice(0, MAX_FIELD) : '';
  return { app, title: title || null };
}

type Pending = { promise: Promise<ForegroundSample | null>; settle: (line: string | null) => void };

/**
 * One long-lived child polled line by line. The main process drives the pace: no request,
 * no read. Nothing is spawned before the first `sample()`.
 */
export function createSampler(deps: SamplerDeps): Sampler | null {
  const command = samplerCommand(deps.platform);
  if (!command) return null;
  const timeoutMs = deps.timeoutMs ?? SAMPLER_TIMEOUT_MS;
  const firstTimeoutMs = deps.firstTimeoutMs ?? SAMPLER_FIRST_TIMEOUT_MS;
  let child: ChildProcess | null = null;
  let lines: Interface | null = null;
  let pending: Pending | null = null;
  let stopped = false;
  let failures: number[] = [];
  /** Sticky: once given up, no respawn until a new sampler ("Tentar de novo"). */
  let gaveUp = false;
  /** The current child has not answered yet. */
  let awaitingFirstReply = false;

  const recordFailure = () => {
    const now = deps.now();
    failures = [...failures.filter((at) => now - at < FAILURE_WINDOW_MS), now];
    if (failures.length >= MAX_FAILURES) gaveUp = true;
  };

  const failed = () => gaveUp;

  const kill = () => {
    const current = child;
    child = null;
    lines?.close();
    lines = null;
    if (current) {
      current.removeAllListeners();
      current.on('error', () => {});
      try {
        current.kill();
      } catch {
        // Already gone.
      }
    }
  };

  const fail = () => {
    recordFailure();
    kill();
  };

  const ensureChild = (): ChildProcess | null => {
    if (child) return child;
    let next: ChildProcess;
    try {
      next = deps.spawn(command.command, command.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
    child = next;
    awaitingFirstReply = true;
    next.stdin?.on('error', () => {});
    next.on('error', () => {
      if (child === next) {
        if (pending) pending.settle(null);
        else fail();
      }
    });
    next.on('exit', () => {
      if (child !== next) return;
      if (pending) pending.settle(null);
      else kill();
    });
    if (next.stdout) {
      lines = createInterface({ input: next.stdout });
      lines.on('line', (line) => {
        if (child === next) pending?.settle(line);
      });
    }
    return next;
  };

  return {
    sample() {
      if (stopped || failed()) return Promise.resolve(null);
      if (pending) return pending.promise;
      const proc = ensureChild();
      if (!proc?.stdin) {
        recordFailure();
        kill();
        return Promise.resolve(null);
      }
      let settle!: (line: string | null) => void;
      const promise = new Promise<ForegroundSample | null>((resolve) => {
        const timer = setTimeout(() => settle(null), awaitingFirstReply ? firstTimeoutMs : timeoutMs);
        settle = (line) => {
          clearTimeout(timer);
          if (pending?.promise !== promise) return;
          pending = null;
          if (line !== null) awaitingFirstReply = false;
          if (line === null || !parseObject(line)) {
            if (!stopped) fail();
            resolve(null);
            return;
          }
          resolve(parseSampleLine(line));
        };
      });
      pending = { promise, settle: (line) => settle(line) };
      proc.stdin.write('s\n');
      return promise;
    },
    stop() {
      stopped = true;
      pending?.settle(null);
      kill();
    },
    failed,
  };
}
