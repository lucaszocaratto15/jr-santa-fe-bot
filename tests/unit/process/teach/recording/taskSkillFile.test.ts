import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDraft } from '@process/services/teach/recording/skillDraft';
import { readTaughtTask, writeTaughtTask } from '@process/services/teach/recording/taskSkillFile';

const SKILL = `---
name: "jr-tarefa-nfs"
description: "Baixa: NFs #mes"
source: taught
created: 2026-10-29
---

## Passos
1. Abrir
`;

const roots: string[] = [];
let skillsDir: string;

const seed = async (name: string, content: string): Promise<string> => {
  const dir = join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8');
  return dir;
};

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'jr-task-skill-'));
  roots.push(root);
  skillsDir = join(root, 'skills');
  await mkdir(skillsDir);
  await seed('jr-tarefa-nfs', SKILL);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const onDisk = () => readFile(join(skillsDir, 'jr-tarefa-nfs', 'SKILL.md'), 'utf8');

describe('readTaughtTask', () => {
  it('reads description unquoted and the body after the frontmatter', async () => {
    const task = await readTaughtTask(skillsDir, 'jr-tarefa-nfs');
    expect(task).toEqual({ name: 'jr-tarefa-nfs', description: 'Baixa: NFs #mes', body: '\n## Passos\n1. Abrir\n' });
  });

  it('rejects a missing skill with not_found', async () => {
    await expect(readTaughtTask(skillsDir, 'jr-tarefa-nada')).rejects.toThrow('not_found');
  });

  it('rejects a name outside jr-tarefa-* with bad_name', async () => {
    await expect(readTaughtTask(skillsDir, 'outra-skill')).rejects.toThrow('bad_name');
  });
});

describe('writeTaughtTask', () => {
  it('writes JSON-quoted name/description and keeps source/created lines', async () => {
    await writeTaughtTask(skillsDir, {
      name: 'jr-tarefa-nfs',
      description: 'Novo: texto # x',
      body: '\n## Passos\n1. Abrir\n2. Baixar\n',
    });
    const text = await onDisk();
    expect(text).toContain('description: "Novo: texto # x"');
    expect(text).toContain('name: "jr-tarefa-nfs"');
    expect(text).toContain('source: taught\ncreated: 2026-10-29\n');
  });

  it('round-trips: write then read returns the same content', async () => {
    const input = { name: 'jr-tarefa-nfs', description: 'Outra descrição', body: '\n## Passos\n1. Um\n2. Dois\n' };
    await writeTaughtTask(skillsDir, input);
    expect(await readTaughtTask(skillsDir, 'jr-tarefa-nfs')).toEqual(input);
  });

  it('rejects names that try to leave the skills dir with bad_name', async () => {
    const body = '\n## Passos\n1. x\n';
    await expect(writeTaughtTask(skillsDir, { name: 'jr-tarefa-../../x', description: 'd', body })).rejects.toThrow(
      'bad_name'
    );
    await expect(writeTaughtTask(skillsDir, { name: 'outra-skill', description: 'd', body })).rejects.toThrow(
      'bad_name'
    );
  });

  it('rejects when the skill dir is a symlink with outside_dir and writes nothing there', async () => {
    const outside = join(roots[0], 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'SKILL.md'), SKILL, 'utf8');
    await symlink(outside, join(skillsDir, 'jr-tarefa-link'));
    await expect(
      writeTaughtTask(skillsDir, { name: 'jr-tarefa-link', description: 'd', body: '\n## Passos\n1. x\n' })
    ).rejects.toThrow('outside_dir');
    expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe(SKILL);
  });

  it('rejects when SKILL.md itself is a symlink with outside_dir', async () => {
    const outside = join(roots[0], 'outside.md');
    await writeFile(outside, SKILL, 'utf8');
    const dir = join(skillsDir, 'jr-tarefa-filelink');
    await mkdir(dir);
    await symlink(outside, join(dir, 'SKILL.md'));
    await expect(readTaughtTask(skillsDir, 'jr-tarefa-filelink')).rejects.toThrow('outside_dir');
  });

  it('rejects a missing skill with not_found', async () => {
    await expect(
      writeTaughtTask(skillsDir, { name: 'jr-tarefa-nada', description: 'd', body: '\n## Passos\n1. x\n' })
    ).rejects.toThrow('not_found');
  });

  it('rejects a body without ## Passos with no_steps and leaves the file untouched', async () => {
    await expect(
      writeTaughtTask(skillsDir, { name: 'jr-tarefa-nfs', description: 'd', body: '\n## Entradas\n- mês\n' })
    ).rejects.toThrow('no_steps');
    expect(await onDisk()).toBe(SKILL);
  });

  it('rejects an empty description with no_description', async () => {
    await expect(
      writeTaughtTask(skillsDir, { name: 'jr-tarefa-nfs', description: '   ', body: '\n## Passos\n1. x\n' })
    ).rejects.toThrow('no_description');
    expect(await onDisk()).toBe(SKILL);
  });

  it('rejects a body over 64 KB with too_large', async () => {
    const body = `\n## Passos\n1. ${'x'.repeat(70 * 1024)}\n`;
    await expect(writeTaughtTask(skillsDir, { name: 'jr-tarefa-nfs', description: 'd', body })).rejects.toThrow(
      'too_large'
    );
    expect(await onDisk()).toBe(SKILL);
  });

  it('a body starting with its own --- block does not replace the frontmatter', async () => {
    const body = '---\nname: jr-tarefa-outra\ndescription: falsa\n---\n\n## Passos\n1. x\n';
    await writeTaughtTask(skillsDir, { name: 'jr-tarefa-nfs', description: 'Verdadeira', body });
    const parsed = parseDraft(await onDisk());
    expect(parsed).toMatchObject({ ok: true, name: 'jr-tarefa-nfs', description: 'Verdadeira' });
  });
});
