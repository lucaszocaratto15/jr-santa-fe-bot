/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mermaid sources of the "Manual da função": one flowchart per activity (steps in order,
 * each "confirmar antes de" as a decision) and one per role (activities by frequency).
 * Labels are escaped so step text cannot change the diagram. Pure.
 */

import type { HandbookActivityBody, HandbookFrequency } from '@/common/types/agent/handbookTypes';

const MAX_LABEL = 60;
const FREQUENCY_LABELS: Record<HandbookFrequency, string> = {
  daily: 'Diárias',
  weekly: 'Semanais',
  occasional: 'Eventuais',
};

/** Quoted Mermaid label: quotes become `#quot;`; brackets, braces, pipes, angle brackets and backticks go. */
export function mermaidLabel(value: string): string {
  const flat = value
    .replace(/[[\]{}()|<>`\\;]/g, ' ')
    .replace(/#/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const short = flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat;
  return `"${short.replace(/"/g, '#quot;')}"`;
}

/** Steps in sequence; the "confirmar antes de" checks are decisions before the last step. */
export function activityFlowchart(activity: HandbookActivityBody): string {
  const lines = ['flowchart TD', `  start([${mermaidLabel(activity.title || 'Atividade')}])`];
  const steps = activity.steps.map((_step, index) => `s${index + 1}`);
  activity.steps.forEach((step, index) => {
    lines.push(`  s${index + 1}[${mermaidLabel(`${index + 1}. ${step.text}`)}]`);
  });
  const checks = activity.confirmBefore.map((_item, index) => `c${index + 1}`);
  activity.confirmBefore.forEach((item, index) => {
    lines.push(`  c${index + 1}{${mermaidLabel(`Confirmar: ${item}`)}}`);
  });
  if (checks.length > 0) lines.push(`  stop([${mermaidLabel('Parar e pedir ajuda')}])`);
  lines.push(`  finish([${mermaidLabel('Fim')}])`);
  // The checks go right before the last step (or the end when there are no steps).
  const beforeChecks = steps.length > 1 ? steps.slice(0, -1) : [];
  const afterChecks = steps.length > 0 ? [steps.at(-1) as string] : [];
  const chain = ['start', ...beforeChecks];
  for (let index = 0; index < chain.length - 1; index += 1) lines.push(`  ${chain[index]} --> ${chain[index + 1]}`);
  let previous = chain.at(-1) as string;
  for (const check of checks) {
    lines.push(`  ${previous} --> ${check}`);
    lines.push(`  ${check} -->|não| stop`);
    previous = check;
  }
  const tail = [...afterChecks, 'finish'];
  lines.push(`  ${previous} ${checks.length > 0 ? '-->|sim|' : '-->'} ${tail[0]}`);
  if (tail.length > 1) lines.push(`  ${tail[0]} --> ${tail[1]}`);
  return lines.join('\n');
}

/** The role's activities grouped by frequency. */
export function roleFlowchart(activities: HandbookActivityBody[], roleTitle = 'Atividades do cargo'): string {
  const lines = ['flowchart TD', `  role([${mermaidLabel(roleTitle)}])`];
  let counter = 0;
  for (const frequency of ['daily', 'weekly', 'occasional'] as const) {
    const group = activities.filter((activity) => activity.frequency === frequency);
    if (group.length === 0) continue;
    lines.push(`  ${frequency}[${mermaidLabel(FREQUENCY_LABELS[frequency])}]`);
    lines.push(`  role --> ${frequency}`);
    for (const activity of group) {
      counter += 1;
      lines.push(`  a${counter}[${mermaidLabel(activity.title)}]`);
      lines.push(`  ${frequency} --> a${counter}`);
    }
  }
  return lines.join('\n');
}
