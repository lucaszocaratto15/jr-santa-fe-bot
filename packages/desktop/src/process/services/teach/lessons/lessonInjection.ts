import type { Lesson } from '@/common/types/agent/lessonTypes';
import { readTaughtTask, writeTaughtTask } from '../recording/taskSkillFile';

export const LESSONS_HEADING = '## Lições';
const MAX_GENERAL_CHARS = 6000;
/** From the heading line to the next level-2 heading (or the end). */
const SECTION_RE = /(?:^|\n)## Lições[ \t]*\n[\s\S]*?(?=\n## |$)/;

/** The body without the generated lessons section (what the editor shows). */
export function stripTaskLessons(body: string): string {
  return body.replace(SECTION_RE, '').trimEnd();
}

/** The body with a fresh lessons section holding the active lessons; no section when there are none. */
export function withTaskLessons(body: string, lessons: Lesson[]): string {
  const base = stripTaskLessons(body);
  const lines = lessons.filter((lesson) => lesson.active).map((lesson) => `- ${lesson.text}`);
  if (lines.length === 0) return base;
  return `${base}\n\n${LESSONS_HEADING}\n${lines.join('\n')}`;
}

/** Active general lessons as "- ..." lines, whole lines only, at most 6000 characters. */
export function generalLessonsText(lessons: Lesson[]): string {
  let out = '';
  for (const lesson of lessons) {
    if (!lesson.active || lesson.scope.kind !== 'general') continue;
    const line = `- ${lesson.text}`;
    const next = out ? `${out}\n${line}` : line;
    if (next.length > MAX_GENERAL_CHARS) break;
    out = next;
  }
  return out;
}

/** Rewrites the task's SKILL.md so its lessons section matches `lessons`. */
export async function syncTaskLessons(skillsDir: string, skill: string, lessons: Lesson[]): Promise<void> {
  const task = await readTaughtTask(skillsDir, skill);
  await writeTaughtTask(skillsDir, { ...task, body: withTaskLessons(task.body, lessons) });
}
