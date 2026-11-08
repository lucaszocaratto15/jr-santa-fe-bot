import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Lesson,
  LessonCounters,
  LessonProposal,
  LessonScope,
  LessonStoreErrorCode,
  LessonVersion,
} from '@/common/types/agent/lessonTypes';
import { redactSecrets } from '@process/resources/builtinMcp/secretRedact';
import { redactTitle } from '../learn/privacyFilter';

export const MAX_LESSON_CHARS = 200;
export const MAX_TASK_LESSONS = 20;
export const MAX_GENERAL_LESSONS = 30;

export type LessonStore = {
  list(): Promise<Lesson[]>;
  save(p: LessonProposal, edited: boolean): Promise<Lesson>;
  /** Saves every item or none: one invalid item rejects the whole batch. */
  saveMany(items: SaveItem[]): Promise<Lesson[]>;
  update(id: string, text: string): Promise<Lesson>;
  setActive(id: string, active: boolean): Promise<Lesson>;
  revert(id: string, versionIndex: number): Promise<Lesson>;
  counters(): Promise<LessonCounters>;
  bump(key: keyof LessonCounters): Promise<void>;
  lastOffered(conversationId: string): Promise<string | null>;
  markOffered(conversationId: string, messageId: string): Promise<void>;
};

export type SaveItem = { proposal: LessonProposal; edited: boolean };

type LessonStoreDeps = { now: () => number; secrets: () => Promise<string[]>; newId: () => string };
type LessonFile = { version: 1; lessons: Lesson[]; counters: LessonCounters; offered: Record<string, string> };

const MAX_FILE_BYTES = 4_194_304;
/** redactTitle truncates at 120 chars, so longer text is checked in chunks below that. */
const CHUNK_CHARS = 100;

const emptyFile = (): LessonFile => ({
  version: 1,
  lessons: [],
  counters: { offered: 0, saved: 0, edited: 0, discarded: 0 },
  offered: {},
});

/** Thrown by parseFile for content that is not a lesson file we can trust. */
class CorruptFileError extends Error {}

const fail = (code: LessonStoreErrorCode): never => {
  throw Object.assign(new Error(`JR_LESSON_${code.toUpperCase()}`), { code });
};

const chunks = (text: string): string[] => {
  const out: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > CHUNK_CHARS) {
      out.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out;
};

/** True when the text holds a live vault secret or personal data (CPF, CNPJ, e-mail, plate, long digit run). */
export function containsSecret(text: string, secrets: readonly string[]): boolean {
  if (redactSecrets(text, secrets) !== text) return true;
  return chunks(text).some((chunk) => redactTitle(chunk) !== chunk);
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const validLesson = (raw: unknown): raw is Lesson =>
  record(raw) &&
  typeof raw.id === 'string' &&
  typeof raw.text === 'string' &&
  typeof raw.active === 'boolean' &&
  typeof raw.createdAt === 'number' &&
  typeof raw.sourceQuote === 'string' &&
  Array.isArray(raw.versions) &&
  record(raw.scope) &&
  (raw.scope.kind === 'general' || (raw.scope.kind === 'task' && typeof raw.scope.skill === 'string'));

const parseFile = (text: string): LessonFile => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CorruptFileError('invalid json');
  }
  if (!record(value) || value.version !== 1 || !Array.isArray(value.lessons)) throw new CorruptFileError('bad shape');
  const base = emptyFile();
  const counters = record(value.counters) ? value.counters : {};
  for (const key of Object.keys(base.counters) as (keyof LessonCounters)[]) {
    const n = counters[key];
    if (typeof n === 'number' && Number.isFinite(n)) base.counters[key] = n;
  }
  const offered: Record<string, string> = {};
  if (record(value.offered)) {
    for (const [k, v] of Object.entries(value.offered)) if (typeof v === 'string') offered[k] = v;
  }
  return { version: 1, lessons: value.lessons.filter(validLesson), counters: base.counters, offered };
};

/** One line of plain text: newlines and runs of spaces become one space (no stray `## ` headings). */
export const normalizeLessonText = (text: string): string => text.replace(/\s+/g, ' ').trim();

const sameScope = (a: LessonScope, b: LessonScope): boolean =>
  a.kind === b.kind && (a.kind === 'general' || (b.kind === 'task' && a.skill === b.skill));

export function createLessonStore(userDataDir: string, deps: LessonStoreDeps): LessonStore {
  const directory = join(userDataDir, 'jr-lessons');
  const file = join(directory, 'lessons.json');
  let chain: Promise<unknown> = Promise.resolve();

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  };

  /**
   * Only a missing file is empty. A corrupt one is moved aside (kept for recovery) and the store
   * starts empty; any other read error throws so the next write cannot overwrite real lessons.
   */
  const load = async (): Promise<LessonFile> => {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
      throw error;
    }
    try {
      if (text.length > MAX_FILE_BYTES) throw new CorruptFileError('too large');
      return parseFile(text);
    } catch (error) {
      if (!(error instanceof CorruptFileError)) throw error;
      await rename(file, `${file}.corrupt-${deps.now()}`);
      return emptyFile();
    }
  };

  const write = async (data: LessonFile): Promise<void> => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `lessons.json.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(data));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };

  /** Load, mutate, persist (only when the mutation does not throw). */
  const mutate = <T>(fn: (data: LessonFile) => Promise<T> | T): Promise<T> =>
    serialize(async () => {
      const data = await load();
      const result = await fn(data);
      await write(data);
      return result;
    });

  /** The normalized text, or a too_long / secret failure. */
  const checkText = async (raw: string): Promise<string> => {
    const text = normalizeLessonText(raw);
    if (text.length > MAX_LESSON_CHARS) fail('too_long');
    if (containsSecret(text, await deps.secrets())) fail('secret');
    return text;
  };

  const checkScope = (scope: LessonScope): void => {
    if (scope.kind === 'task' && (typeof scope.skill !== 'string' || !scope.skill.trim())) fail('bad_scope');
    if (scope.kind !== 'task' && scope.kind !== 'general') fail('bad_scope');
  };

  const checkLimit = (data: LessonFile, scope: LessonScope, ignoreId?: string): void => {
    const active = data.lessons.filter((l) => l.active && l.id !== ignoreId && sameScope(l.scope, scope));
    if (scope.kind === 'general' && active.length >= MAX_GENERAL_LESSONS) fail('limit_general');
    if (scope.kind === 'task' && active.length >= MAX_TASK_LESSONS) fail('limit_task');
  };

  const find = (data: LessonFile, id: string): Lesson => data.lessons.find((l) => l.id === id) ?? fail('not_found');

  const pushVersion = (lesson: Lesson, text: string): void => {
    const version: LessonVersion = { text: lesson.text, at: deps.now() };
    lesson.versions.push(version);
    lesson.text = text;
  };

  /** Applies one approved proposal to `data` in memory (an update keeps the lesson's own scope). */
  const saveInto = async (data: LessonFile, p: LessonProposal, edited: boolean): Promise<Lesson> => {
    checkScope(p.scope);
    const text = await checkText(p.text);
    let lesson: Lesson;
    if (p.updateId) {
      lesson = find(data, p.updateId);
      pushVersion(lesson, text);
    } else {
      checkLimit(data, p.scope);
      lesson = {
        id: deps.newId(),
        scope: p.scope,
        text,
        active: true,
        createdAt: deps.now(),
        sourceQuote: p.sourceQuote,
        versions: [],
      };
      data.lessons.push(lesson);
    }
    data.counters.saved += 1;
    if (edited) data.counters.edited += 1;
    return lesson;
  };

  return {
    list: () => serialize(async () => (await load()).lessons),

    save: (p, edited) => mutate((data) => saveInto(data, p, edited)),

    // mutate writes nothing when one item throws, so the batch is all-or-nothing.
    saveMany: (items) =>
      mutate(async (data) => {
        const saved: Lesson[] = [];
        for (const { proposal, edited } of items) saved.push(await saveInto(data, proposal, edited));
        return saved;
      }),

    update: (id, raw) =>
      mutate(async (data) => {
        const lesson = find(data, id);
        pushVersion(lesson, await checkText(raw));
        return lesson;
      }),

    setActive: (id, active) =>
      mutate((data) => {
        const lesson = find(data, id);
        if (active && !lesson.active) checkLimit(data, lesson.scope, id);
        lesson.active = active;
        return lesson;
      }),

    revert: (id, versionIndex) =>
      mutate(async (data) => {
        const lesson = find(data, id);
        const target = lesson.versions[versionIndex];
        if (!target) return fail('not_found');
        // An old version is screened like new text: the vault may hold that value by now.
        pushVersion(lesson, await checkText(target.text));
        return lesson;
      }),

    counters: () => serialize(async () => (await load()).counters),

    bump: (key) =>
      mutate((data) => {
        data.counters[key] += 1;
      }),

    lastOffered: (conversationId) => serialize(async () => (await load()).offered[conversationId] ?? null),

    markOffered: (conversationId, messageId) =>
      mutate((data) => {
        data.offered[conversationId] = messageId;
      }),
  };
}
