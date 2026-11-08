export type LessonScope = { kind: 'general' } | { kind: 'task'; skill: string };
export type LessonVersion = { text: string; at: number };
export type Lesson = {
  id: string;
  scope: LessonScope;
  text: string;
  active: boolean;
  createdAt: number;
  sourceQuote: string;
  versions: LessonVersion[];
};
export type LessonCounters = { offered: number; saved: number; edited: number; discarded: number };
export type LessonProposal = { text: string; scope: LessonScope; sourceQuote: string; updateId?: string };
export type TranscriptMessage = { id: string; role: 'user' | 'assistant' | 'tool'; text: string };
export type LessonStoreErrorCode = 'limit_task' | 'limit_general' | 'secret' | 'too_long' | 'not_found' | 'bad_scope';
