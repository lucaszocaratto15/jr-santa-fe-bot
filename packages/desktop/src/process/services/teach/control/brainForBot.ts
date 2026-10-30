/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Text the bot reads from the company brain (`brain_search`, `brain_wrong`). Pure. The brain only
 * helps the employee understand the work; nothing here evaluates people or tracks time.
 */

import type { BrainFact } from '@/common/types/agent/brainTypes';

export const BRAIN_UNAVAILABLE_TEXT = 'Cérebro indisponível agora; siga sem ele.';
export const BRAIN_EMPTY_TEXT = 'O cérebro não tem nada sobre isso.';
export const BRAIN_WRONG_RECORDED_TEXT = 'Registrado. O cérebro vai rever essa informação.';

/** `- [AAAA-MM-DD · confiança N] texto (área) {id}`; the id is only there so the bot can call brain_wrong. */
export function formatBrainFacts(facts: readonly BrainFact[]): string {
  if (facts.length === 0) return BRAIN_EMPTY_TEXT;
  return facts
    .map((fact) => {
      const date = fact.date ? fact.date.slice(0, 10) : 'sem data';
      const area = fact.area ? ` (${fact.area})` : '';
      return `- [${date} · confiança ${Math.round(fact.confidence)}] ${fact.text}${area} {id: ${fact.id}}`;
    })
    .join('\n');
}
