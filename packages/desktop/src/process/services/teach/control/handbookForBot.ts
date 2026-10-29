/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Text the bot reads from the "Manual da função" (`handbook_lookup`). Pure. It carries the
 * role's activities, steps, flowchart and indicators as text only: no image, image id or
 * screenshot data ever goes to the model.
 */

import type { HandbookItem, HandbookView } from '@/common/types/agent/handbookTypes';

export const HANDBOOK_NO_ROLE_TEXT = 'Seu cargo não está cadastrado no JR Bot. Peça ao administrador para cadastrá-lo.';
export const HANDBOOK_UNAVAILABLE_TEXT = 'O Manual da função só funciona conectado ao servidor da empresa.';
export const handbookEmptyText = (title: string): string => `Ainda não existe Manual da função para o cargo ${title}.`;
export const HANDBOOK_QUIZ_GUIDE =
  'Faça 3 perguntas curtas (ordem dos passos, o que confirmar antes, como saber que deu certo), corrija com base neste manual e sugira rever a tela do passo errado.';

const FREQUENCY: Record<string, string> = { daily: 'diária', weekly: 'semanal', occasional: 'eventual' };
const SHOT_MARKER_RE = /\s*\[tela \d{1,3}\]/g;

const normalize = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Word stems (first 5 letters of words with 3+ letters), so "lançar" matches "lança". */
const stems = (value: string): Set<string> =>
  new Set(
    normalize(value)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3)
      .map((word) => word.slice(0, 5))
  );

const score = (item: HandbookItem, query: Set<string>): number => {
  const words = stems(`${item.body.title} ${item.body.description}`);
  let hits = 0;
  for (const word of query) if (words.has(word)) hits += 1;
  return hits;
};

const flat = (value: string): string => value.replace(/\s+/g, ' ').trim();

function activityBlock(item: HandbookItem): string[] {
  const { body } = item;
  const lines = [`### ${flat(body.title)} (id: ${item.id}, frequência ${FREQUENCY[body.frequency] ?? body.frequency})`];
  if (body.description) lines.push(flat(body.description));
  if (body.steps.length > 0) {
    lines.push('Passos:');
    body.steps.forEach((step, index) => lines.push(`${index + 1}. ${flat(step.text.replace(SHOT_MARKER_RE, ''))}`));
  }
  if (body.confirmBefore.length > 0) {
    lines.push(`Confirmar antes de: ${body.confirmBefore.map(flat).join('; ')}`);
  }
  return lines;
}

/**
 * The role handbook as text for the bot. Activities matching `query` come first; without a
 * match every activity is listed. The fixed texts cover a missing role and an empty handbook.
 */
export function formatHandbookForBot(payload: HandbookView, query?: string): string {
  if (!payload.role) return HANDBOOK_NO_ROLE_TEXT;
  if (payload.items.length === 0) return handbookEmptyText(payload.role.title);
  const wanted = stems(query ?? '');
  const ranked = payload.items
    .map((item, index) => ({ item, index, hits: wanted.size > 0 ? score(item, wanted) : 0 }))
    .toSorted((a, b) => b.hits - a.hits || a.index - b.index);
  const lines = [
    `Manual da função do cargo ${payload.role.title}.`,
    'Responda só com o que está neste manual. Não invente funções nem passos.',
    '',
    'Atividades do cargo:',
    ...ranked.map(
      ({ item }) =>
        `- ${flat(item.body.title)} (id: ${item.id}, ${FREQUENCY[item.body.frequency] ?? item.body.frequency})`
    ),
    '',
  ];
  if (wanted.size > 0 && ranked[0].hits === 0) lines.push('Nenhuma atividade corresponde ao pedido; seguem todas.', '');
  for (const { item } of ranked) lines.push(...activityBlock(item), '');
  lines.push('Fluxograma do cargo:', '```mermaid', payload.roleFlowchart, '```', '');
  const indicators = payload.indicators;
  if (indicators && (indicators.activities.length > 0 || indicators.timePerApp.length > 0)) {
    lines.push(`Indicadores do cargo (média de ${indicators.contributors} pessoa(s), últimas 4 semanas):`);
    for (const activity of indicators.activities) {
      lines.push(
        `- ${flat(activity.title)}: ${activity.timesPerWeek} vez(es) por semana, ${activity.minutesPerRun} min por vez`
      );
    }
    for (const app of indicators.timePerApp) lines.push(`- ${flat(app.app)}: ${app.minutesPerDay} min por dia`);
    lines.push('');
  }
  lines.push(
    'Para mostrar ao funcionário o fluxograma e a repetição tela a tela de uma atividade, chame handbook_show com o id dela.',
    `quizGuide: ${HANDBOOK_QUIZ_GUIDE}`
  );
  return lines.join('\n');
}
