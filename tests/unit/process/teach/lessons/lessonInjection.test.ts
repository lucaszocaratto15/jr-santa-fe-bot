import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lesson } from '@/common/types/agent/lessonTypes';
import {
  generalLessonsText,
  LESSONS_HEADING,
  stripTaskLessons,
  syncTaskLessons,
  withTaskLessons,
} from '@/process/services/teach/lessons/lessonInjection';
import { createLessonStore } from '@/process/services/teach/lessons/lessonStore';

const lesson = (text: string, over: Partial<Lesson> = {}): Lesson => ({
  id: text,
  scope: { kind: 'task', skill: 'jr-tarefa-exemplo' },
  text,
  active: true,
  createdAt: 1,
  sourceQuote: 'q',
  versions: [{ text, at: 1 }],
  ...over,
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('task lessons section', () => {
  const body = '# Passos\n1. Abrir\n2. Salvar';

  it('replaces an existing section instead of duplicating it', () => {
    const once = withTaskLessons(body, [lesson('A')]);
    const twice = withTaskLessons(once, [lesson('B')]);
    expect(twice.split(LESSONS_HEADING).length).toBe(2);
    expect(twice).toContain('- B');
    expect(twice).not.toContain('- A');
  });

  it('keeps sections that follow the lessons section', () => {
    const text = `${body}\n\n${LESSONS_HEADING}\n- A\n\n## Notas\nfim`;
    expect(stripTaskLessons(text)).toBe(`${body}\n\n## Notas\nfim`);
  });

  it('leaves out inactive lessons and adds no heading when none are active', () => {
    expect(withTaskLessons(body, [lesson('A', { active: false })])).toBe(body);
    expect(withTaskLessons(body, [])).not.toContain(LESSONS_HEADING);
  });

  it('strip undoes with', () => {
    expect(stripTaskLessons(withTaskLessons(body, [lesson('A'), lesson('B')]))).toBe(body.trimEnd());
  });

  it('caps general lessons at 6000 characters and skips task and inactive ones', () => {
    const general = (text: string, active = true) => lesson(text, { scope: { kind: 'general' }, active });
    const many = Array.from({ length: 100 }, (_, i) => general(`${'x'.repeat(190)}${i}`));
    expect(generalLessonsText(many).length).toBeLessThanOrEqual(6000);
    expect(generalLessonsText([general('a'), general('b', false), lesson('t')])).toBe('- a');
    expect(generalLessonsText([])).toBe('');
  });

  it('after a revert the section carries the old text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jr-inject-'));
    roots.push(dir);
    let n = 0;
    let t = 0;
    const store = createLessonStore(dir, { now: () => ++t, secrets: async () => [], newId: () => `id${++n}` });
    const saved = await store.save(
      { text: 'versao um', scope: { kind: 'task', skill: 'jr-tarefa-exemplo' }, sourceQuote: 'q' },
      false
    );
    await store.update(saved.id, 'versao dois');
    const reverted = await store.revert(saved.id, 0);
    expect(withTaskLessons(body, [reverted])).toContain('- versao um');
  });

  it('syncTaskLessons rewrites SKILL.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jr-sync-'));
    roots.push(dir);
    await mkdir(join(dir, 'jr-tarefa-exemplo'));
    await writeFile(
      join(dir, 'jr-tarefa-exemplo', 'SKILL.md'),
      '---\nname: jr-tarefa-exemplo\ndescription: "Faz x"\n---\n## Passos\n1. Abrir\n'
    );
    await syncTaskLessons(dir, 'jr-tarefa-exemplo', [lesson('Sempre conferir o total')]);
    const text = await readFile(join(dir, 'jr-tarefa-exemplo', 'SKILL.md'), 'utf8');
    expect(text).toContain(`${LESSONS_HEADING}\n- Sempre conferir o total`);
    expect(text).toContain('## Passos');
  });
});
