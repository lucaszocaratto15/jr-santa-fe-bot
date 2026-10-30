/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { Lesson, LessonProposal, LessonScope, TranscriptMessage } from '@/common/types/agent/lessonTypes';
import { getJrModelConnection } from '@process/services/jr/modelConnection';
import { userSkillsDir } from '../control/teachIpc';
import { extractLessons } from './extract';
import { generalLessonsText, syncTaskLessons } from './lessonInjection';
import { getLessonStore, vaultSecrets } from './lessonRuntime';
import type { LessonStore } from './lessonStore';

const TAUGHT_SKILL_PREFIX = 'jr-tarefa-';

export type LessonsIpcDeps = {
  store: LessonStore;
  extract: typeof extractLessons;
  /** Names of the taught-task skills installed for this employee. */
  installedSkills: () => Promise<string[]>;
  secrets: () => Promise<string[]>;
  connection: () => ReturnType<typeof getJrModelConnection>;
  /** Rewrites the lessons section of one task's SKILL.md. */
  syncTask: (skill: string, lessons: Lesson[]) => Promise<void>;
  emitChanged: (scope: LessonScope['kind']) => void;
};

export type SaveInput = {
  conversationId: string;
  upToMessageId: string;
  accepted: { proposal: LessonProposal; edited: boolean }[];
  discarded: number;
};

/** All lessons of one task, active or not (the section builder keeps the active ones). */
const lessonsOfTask = (all: Lesson[], skill: string): Lesson[] =>
  all.filter((lesson) => lesson.scope.kind === 'task' && lesson.scope.skill === skill);

export function createLessonsHandlers(deps: LessonsIpcDeps) {
  const { store } = deps;

  const syncSkill = async (skill: string): Promise<void> => {
    try {
      await deps.syncTask(skill, lessonsOfTask(await store.list(), skill));
    } catch (error) {
      // The lesson itself is stored; a task file that cannot be rewritten must not hide that.
      console.warn('[lessons] could not sync task lessons', skill, error);
    }
  };

  /** Sync every touched task once and tell the renderer what kinds changed. */
  const afterChange = async (scopes: LessonScope[]): Promise<void> => {
    const skills = new Set<string>();
    let general = false;
    for (const scope of scopes) {
      if (scope.kind === 'task') skills.add(scope.skill);
      else general = true;
    }
    for (const skill of skills) await syncSkill(skill);
    if (skills.size > 0) deps.emitChanged('task');
    if (general) deps.emitChanged('general');
  };

  const mutateOne = async (run: () => Promise<Lesson>): Promise<Lesson> => {
    const lesson = await run();
    await afterChange([lesson.scope]);
    return lesson;
  };

  return {
    list: () => store.list(),
    counters: () => store.counters(),
    lastOffered: ({ conversationId }: { conversationId: string }) => store.lastOffered(conversationId),
    generalText: async () => generalLessonsText(await store.list()),

    async extract({ conversationId, messages }: { conversationId: string; messages: TranscriptMessage[] }) {
      const upToMessageId = messages.at(-1)?.id ?? '';
      if (!upToMessageId) return { proposals: [] as LessonProposal[], upToMessageId };
      const [existing, secrets, installedSkills] = await Promise.all([
        store.list(),
        deps.secrets(),
        deps.installedSkills(),
      ]);
      const proposals = await deps.extract({
        messages,
        installedSkills,
        existing,
        secrets,
        connection: deps.connection(),
      });
      if (proposals.length > 0) {
        await store.bump('offered');
        await store.markOffered(conversationId, upToMessageId);
      }
      return { proposals, upToMessageId };
    },

    async save({ conversationId, upToMessageId, accepted, discarded }: SaveInput): Promise<Lesson[]> {
      const saved: Lesson[] = [];
      try {
        // store.save already counts saved/edited.
        for (const { proposal, edited } of accepted) saved.push(await store.save(proposal, edited));
      } finally {
        await afterChange(saved.map((lesson) => lesson.scope));
      }
      for (let i = 0; i < discarded; i += 1) await store.bump('discarded');
      await store.markOffered(conversationId, upToMessageId);
      return saved;
    },

    update: ({ id, text }: { id: string; text: string }) => mutateOne(() => store.update(id, text)),
    setActive: ({ id, active }: { id: string; active: boolean }) => mutateOne(() => store.setActive(id, active)),
    revert: ({ id, versionIndex }: { id: string; versionIndex: number }) =>
      mutateOne(() => store.revert(id, versionIndex)),
  };
}

/** "Lições" IPC: list, extract, approve and edit lessons. Secrets never cross. */
export function initLessonsBridge(): void {
  const handlers = createLessonsHandlers({
    store: getLessonStore(),
    extract: extractLessons,
    installedSkills: async () => {
      try {
        const skills = await ipcBridge.fs.listAvailableSkills.invoke();
        return skills.map((skill) => skill.name).filter((name) => name.startsWith(TAUGHT_SKILL_PREFIX));
      } catch {
        return [];
      }
    },
    secrets: vaultSecrets,
    connection: getJrModelConnection,
    syncTask: async (skill, lessons) => syncTaskLessons(await userSkillsDir(), skill, lessons),
    emitChanged: (scope) => ipcBridge.teach.lessonsChanged.emit({ scope }),
  });
  ipcBridge.teach.lessonsList.provider(async () => handlers.list());
  ipcBridge.teach.lessonsCounters.provider(async () => handlers.counters());
  ipcBridge.teach.lessonsExtract.provider(async (input) => handlers.extract(input));
  ipcBridge.teach.lessonsSave.provider(async (input) => handlers.save(input));
  ipcBridge.teach.lessonsUpdate.provider(async (input) => handlers.update(input));
  ipcBridge.teach.lessonsSetActive.provider(async (input) => handlers.setActive(input));
  ipcBridge.teach.lessonsRevert.provider(async (input) => handlers.revert(input));
  ipcBridge.teach.lessonsLastOffered.provider(async (input) => handlers.lastOffered(input));
  ipcBridge.teach.lessonsGeneralText.provider(async () => handlers.generalText());
}
