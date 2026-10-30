import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { Lesson } from '@/common/types/agent/lessonTypes';
import { getTeachServices } from '../registry';
import { createLessonStore, type LessonStore } from './lessonStore';

/** Vault usernames and passwords, read in the main process only so lesson text can be screened. */
export async function vaultSecrets(): Promise<string[]> {
  const vault = getTeachServices()?.vault;
  if (!vault?.available()) return [];
  const out: string[] = [];
  for (const item of await vault.list()) {
    for (const field of ['username', 'password'] as const) {
      const value = await vault.readSecret(item.id, field).catch((): null => null);
      if (value) out.push(value);
    }
  }
  return out;
}

let store: LessonStore | null = null;

export function getLessonStore(): LessonStore {
  store ??= createLessonStore(app.getPath('userData'), { now: Date.now, newId: randomUUID, secrets: vaultSecrets });
  return store;
}

/** Active lessons that belong to one taught task. */
export async function activeLessonsFor(skill: string): Promise<Lesson[]> {
  const lessons = await getLessonStore().list();
  return lessons.filter((l) => l.active && l.scope.kind === 'task' && l.scope.skill === skill);
}
