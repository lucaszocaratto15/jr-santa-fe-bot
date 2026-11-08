/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reads and rewrites a taught task's `SKILL.md` ("Minhas tarefas" → Editar). Pure file I/O
 * with the skills dir injected. Only `jr-tarefa-*` dirs directly under the skills dir are
 * touched; symlinks are refused and writes are atomic (tmp + rename).
 */

import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TaughtTaskContent, TaughtTaskErrorCode } from '@/common/types/agent/teachTypes';
import { parseDraft, parseFrontmatter, TAUGHT_SKILL_NAME_RE, withDraftDescription, withDraftName } from './skillDraft';

export type { TaughtTaskContent, TaughtTaskErrorCode };

const SKILL_FILE = 'SKILL.md';
/** Same split rule as `skillDraft.ts`. */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;

const fail = (code: TaughtTaskErrorCode): never => {
  throw new Error(code);
};

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';

/** The task's SKILL.md path, after checking the name and that nothing on the way is a symlink. */
async function resolveSkillFile(skillsDir: string, name: string): Promise<string> {
  if (!TAUGHT_SKILL_NAME_RE.test(name)) fail('bad_name');
  const dir = path.join(skillsDir, name);
  const file = path.join(dir, SKILL_FILE);
  try {
    const [dirStat, fileStat] = [await lstat(dir), await lstat(file)];
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile()) {
      fail('outside_dir');
    }
    const [root, real] = await Promise.all([realpath(skillsDir), realpath(dir)]);
    if (path.dirname(real) !== root) fail('outside_dir');
  } catch (error) {
    if (isMissing(error)) fail('not_found');
    throw error;
  }
  return file;
}

const splitFrontmatter = (text: string): { front: string; meta: Record<string, string>; body: string } => {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = FRONTMATTER_RE.exec(normalized);
  if (!match) return fail('no_frontmatter');
  return {
    front: `---\n${match[1]}\n---`,
    meta: parseFrontmatter(match[1]),
    body: normalized.slice(match[0].length),
  };
};

/** The task's description (unquoted) and the SKILL.md body after the frontmatter. */
export async function readTaughtTask(skillsDir: string, name: string): Promise<TaughtTaskContent> {
  const file = await resolveSkillFile(skillsDir, name);
  const { meta, body } = splitFrontmatter(await readFile(file, 'utf8'));
  return { name, description: meta.description ?? '', body };
}

/**
 * Rewrites the task: `name`/`description` JSON-quoted, other frontmatter lines kept as they
 * are, the new body after it. Rejects with a {@link TaughtTaskErrorCode} and writes nothing
 * when the result would not pass `parseDraft`.
 */
export async function writeTaughtTask(skillsDir: string, input: TaughtTaskContent): Promise<void> {
  const file = await resolveSkillFile(skillsDir, input.name);
  const { front } = splitFrontmatter(await readFile(file, 'utf8'));
  const body = input.body.replace(/\r\n/g, '\n');
  const text = withDraftDescription(withDraftName(`${front}\n${body}`, input.name), input.description);
  const parsed = parseDraft(text);
  if (parsed.ok === false) return fail(parsed.code);
  if (parsed.name !== input.name) return fail('bad_name');
  const tmp = `${file}.tmp`;
  await rm(tmp, { force: true });
  try {
    // 'wx': never follow a planted tmp symlink.
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
