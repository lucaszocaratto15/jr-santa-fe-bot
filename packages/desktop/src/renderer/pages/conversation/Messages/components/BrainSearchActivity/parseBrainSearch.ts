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
