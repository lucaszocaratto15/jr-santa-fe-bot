import { describe, expect, it } from 'vitest';
import type { LearnInsightBatch } from '@/common/types/agent/learnTypes';
import {
  activitiesFromInsights,
  activityFromSkill,
  draftHash,
  weeklyIndicators,
  weekStartOf,
} from '@process/services/teach/handbook/draftBuilder';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 29, 15);

const task = {
  name: 'jr-tarefa-lancar-nf',
  description: 'Lança a nota fiscal no portal',
  body: [
    '',
    '## Passos',
    '1. Abrir o portal [tela 1]',
    '2. Entrar com `cofre:portal` [tela 2] [tela 3]',
    '3. Clicar em Emitir [tela 9]',
    '',
    '## Confirmar antes de',
    '- Valor da nota',
    '',
  ].join('\n'),
};

const batch = (
  createdAt: number,
  repetitive: LearnInsightBatch['repetitive'],
  apps = [{ app: 'Excel', minutes: 60 }]
) =>
  ({
    id: String(createdAt),
    createdAt,
    periodStart: createdAt - DAY,
    periodEnd: createdAt,
    timePerApp: apps,
    repetitive,
    suggestions: [],
  }) satisfies LearnInsightBatch;

describe('activityFromSkill', () => {
  it('builds steps from ## Passos and maps [tela N] to shots, stripping the markers', () => {
    const activity = activityFromSkill(task, [1, 3, 5]);
    expect(activity.steps).toEqual([
      { text: 'Abrir o portal', shot: 1 },
      { text: 'Entrar com `cofre:portal`', shot: 3 },
      { text: 'Clicar em Emitir' },
    ]);
    expect(activity.shots).toEqual([1, 3]);
    expect(activity.confirmBefore).toEqual(['Valor da nota']);
    expect(activity.skillName).toBe('jr-tarefa-lancar-nf');
    expect(activity.title).toBe('Lança a nota fiscal no portal');
    expect(JSON.stringify(activity)).not.toContain('[tela');
  });

  it('drops a [tela 9] reference whose file does not exist', () => {
    const activity = activityFromSkill(task, []);
    expect(activity.steps.every((step) => step.shot === undefined)).toBe(true);
    expect(activity.shots).toEqual([]);
  });
});

describe('insight drafts', () => {
  const batches = [
    batch(NOW - DAY, [{ title: 'Lançar NF', description: 'Lança notas', times: 4, minutes: 24 }]),
    batch(NOW - 2 * DAY, [{ title: 'lancar nf', description: 'x', times: 2, minutes: 12 }]),
    batch(NOW - 3 * DAY, [{ title: 'Conferir banco', description: 'Confere', times: 1, minutes: 10 }]),
    batch(NOW - 10 * DAY, [{ title: 'Antigo', description: 'fora da semana', times: 9, minutes: 9 }]),
  ];

  it('groups activities by title and derives the frequency from the weekly count', () => {
    const activities = activitiesFromInsights(batches.slice(0, 3));
    expect(activities.map((a) => [a.title, a.frequency])).toEqual([
      ['Lançar NF', 'daily'],
      ['Conferir banco', 'weekly'],
    ]);
    expect(activities[0].steps).toEqual([]);
  });

  it('weekly indicators use only the last 7 days', () => {
    const indicators = weeklyIndicators(batches, NOW);
    expect(indicators?.weekStart).toBe(weekStartOf(NOW));
    expect(indicators?.activities).toEqual([
      { title: 'Lançar NF', timesPerWeek: 6, minutesPerRun: 6 },
      { title: 'Conferir banco', timesPerWeek: 1, minutesPerRun: 10 },
    ]);
    expect(indicators?.timePerApp).toEqual([{ app: 'Excel', minutesPerDay: 60 }]);
    expect(weeklyIndicators([batches[3]], NOW)).toBeNull();
  });

  it('weekStartOf is the Monday of the week', () => {
    expect(weekStartOf(Date.UTC(2026, 9, 29))).toBe('2026-10-26');
    expect(weekStartOf(Date.UTC(2026, 10, 1))).toBe('2026-10-26');
  });
});

describe('draftHash', () => {
  it('is stable across key order and changes with the content', () => {
    expect(draftHash({ a: 1, b: [1, 2] }, [1])).toBe(draftHash({ b: [1, 2], a: 1 }, [1]));
    expect(draftHash({ a: 1 }, [1])).not.toBe(draftHash({ a: 2 }, [1]));
    expect(draftHash({ a: 1 }, [1])).not.toBe(draftHash({ a: 1 }, [2]));
  });
});
