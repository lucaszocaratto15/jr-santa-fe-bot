/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reads what `brain_search` (MCP server `jr-teach`) answered, only to count facts for the chat
 * animation. Format: see formatBrainFacts in process/services/teach/control/brainForBot.ts.
 * Fact text and ids are never returned from here.
 */

import type { NormalizedToolStatus } from '@/common/chat/normalizeToolCall';

export type BrainSearchOutcome = { kind: 'found'; count: number } | { kind: 'unavailable' };

const BRAIN_UNAVAILABLE_MARKER = 'Cérebro indisponível';
// `- [AAAA-MM-DD · confiança N] texto`; one line per fact.
const FACT_LINE = /^\s*- \[[^\]\n]*\]/;

/** True for `brain_search` as the runtime names it (bare, or prefixed by the MCP server). */
export function isBrainSearchTool(name: string | undefined): boolean {
  return typeof name === 'string' && /^(?:.*(?:__|[:/.]))?brain_search$/i.test(name.trim());
}

export function parseBrainSearchOutput(output: string | undefined): BrainSearchOutcome {
  const text = output ?? '';
  if (text.includes(BRAIN_UNAVAILABLE_MARKER)) return { kind: 'unavailable' };
  return { kind: 'found', count: text.split('\n').filter((line) => FACT_LINE.test(line)).length };
}

type BrainCall = { status: NormalizedToolStatus; output?: string };

/**
 * Folds every brain_search of one bot reply into a single animation: running while any call
 * runs, then the facts of all calls that answered. Unavailable only when no call answered.
 */
export function mergeBrainSearchCalls(calls: BrainCall[]): BrainCall {
  if (calls.some((call) => call.status === 'pending' || call.status === 'running')) return { status: 'running' };
  const completed = calls.filter((call) => call.status === 'completed');
  if (completed.length === 0) return calls[0] ?? { status: 'error' };
  const answered = completed.filter((call) => parseBrainSearchOutput(call.output).kind === 'found');
  if (answered.length === 0) return completed[0];
  return { status: 'completed', output: answered.map((call) => call.output ?? '').join('\n') };
}
