/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Main-side state of the "Ensinar tarefa" flow around the recorder: keeps the employee's
 * description, the stopped recording awaiting review, the elapsed-time ticks for the
 * recording bar, the bot's draft submission and the "Assumir" browser take-over.
 */

import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CdpBridgeHandle } from '@process/resources/builtinMcp/cdpBridge';
import { SHOTS_DIRNAME, type Recorder } from './recorder';
import {
  buildDraftPrompt,
  parseDraft,
  withDraftDescription,
  withDraftName,
  type DraftErrorCode,
  type TeachDraft,
} from './skillDraft';
import { extractShotRefs } from './stepShots';
import { summarizeEvents } from './timeline';
import type {
  TeachDraftEvent,
  TeachDraftRejectedEvent,
  TeachSaveDraftInput,
  TeachStateEvent,
  TeachStopResult,
} from '@/common/types/agent/teachTypes';

export type { TeachDraftEvent, TeachDraftRejectedEvent, TeachSaveDraftInput, TeachStateEvent, TeachStopResult };

/** Error messages of saveDraft are codes the renderer maps to i18n. */
export type TeachSaveErrorCode = DraftErrorCode | 'no_review';

export type TeachSubmitResult = { ok: true; result: string } | { ok: false; error: string };

export type TeachSessionDeps = {
  /** Null when the CDP bridge is off: teach recording is then unavailable. */
  recorder(): Recorder | null;
  bridge(): Pick<CdpBridgeHandle, 'setClientsLocked'> | null;
  /** Offer to save the password typed on `origin` (secure card, purpose 'save-only'). */
  offerSave(origin: string): void;
  emitState(event: TeachStateEvent): void;
  emitDraft(event: TeachDraftEvent): void;
  emitDraftRejected(event: TeachDraftRejectedEvent): void;
  /** `<userData>/taught-tasks` (same base dir as the recorder). */
  dir: string;
  /**
   * `<userData>/taught-shots`: a copy of each skill's cited screenshots, kept in case the
   * skill import does not carry the `telas/` subfolder.
   */
  shotsDir?: string;
  /** Total byte limit of an imported skill folder; null when unknown. */
  maxSkillBytes?: () => Promise<number | null>;
  now?: () => number;
  tickMs?: number;
};

export type TeachSession = {
  available(): boolean;
  start(description: string): Promise<{ id: string }>;
  pause(): void;
  resume(): void;
  stop(): Promise<TeachStopResult>;
  /** Called by the recorder when the 10-minute limit stops it. */
  handleAutoStop(): Promise<void>;
  discard(): Promise<void>;
  submitDraft(markdown: string): Promise<TeachSubmitResult>;
  saveDraft(input: TeachSaveDraftInput): Promise<{ skillPath: string }>;
  takeOver(on: boolean): void;
  /** Whether the employee currently holds the browser ("Assumir"), for renderer resync. */
  takeOverState(): { on: boolean };
};

/** Reason surfaced to the agent (`browser locked: …`) while the employee drives. */
export const TAKE_OVER_REASON = 'o funcionário assumiu o navegador; aguarde ele devolver';
export const TEACH_ERRORS = {
  unavailable: 'gravação indisponível: o controle do navegador está desligado',
  noDescription: 'descreva a tarefa antes de gravar',
  noReview: 'nenhuma gravação aguardando revisão',
  recording: 'há uma gravação em andamento',
} as const;

/** Recordings and draft skills live in `<userData>/taught-tasks/<recordingId>/`. */
export const TAUGHT_TASKS_DIRNAME = 'taught-tasks';
/** Fallback copy of the cited screenshots: `<userData>/taught-shots/<skill>/<n>.jpg`. */
export const TAUGHT_SHOTS_DIRNAME = 'taught-shots';
/** Cited screenshots are copied to `<skill>/telas/<n>.jpg`. */
export const SKILL_SHOTS_DIRNAME = 'telas';
const TICK_MS = 1_000;

const fail = (code: TeachSaveErrorCode): Error => new Error(code);

const fileSize = async (file: string): Promise<number | null> => {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
};

/**
 * Copy the screenshots the draft cites (`[tela N]`) into `<skill>/telas/` and the fallback dir.
 * When the folder would pass the import limit, the oldest shots are left out.
 */
async function copyCitedShots(input: {
  text: string;
  source: string;
  skillPath: string;
  fallback: string | null;
  limit: number | null;
}): Promise<void> {
  const cited = await Promise.all(
    extractShotRefs(input.text).map(async (n) => ({ n, size: await fileSize(path.join(input.source, `${n}.jpg`)) }))
  );
  const kept = cited.filter((shot): shot is { n: number; size: number } => shot.size !== null);
  if (input.limit !== null) {
    let total = Buffer.byteLength(input.text, 'utf8') + kept.reduce((sum, shot) => sum + shot.size, 0);
    kept.sort((a, b) => a.n - b.n);
    while (kept.length > 0 && total > input.limit) total -= kept.shift()?.size ?? 0;
  }
  const targets = [path.join(input.skillPath, SKILL_SHOTS_DIRNAME)];
  if (input.fallback) {
    await rm(input.fallback, { recursive: true, force: true });
    targets.push(input.fallback);
  }
  if (kept.length === 0) return;
  await Promise.all(
    targets.map(async (target) => {
      await mkdir(target, { recursive: true });
      await Promise.all(
        kept.map((shot) => copyFile(path.join(input.source, `${shot.n}.jpg`), path.join(target, `${shot.n}.jpg`)))
      );
    })
  );
}

export function createTeachSession(deps: TeachSessionDeps): TeachSession {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? TICK_MS;
  let description = '';
  let startedAt = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let awaiting: { id: string; description: string } | null = null;
  let takenOver = false;

  const requireRecorder = (): Recorder => {
    const recorder = deps.recorder();
    if (!recorder) throw new Error(TEACH_ERRORS.unavailable);
    return recorder;
  };

  const emitState = () => {
    const state = deps.recorder()?.state() ?? 'idle';
    deps.emitState({ state, elapsedMs: state === 'idle' ? 0 : Math.max(0, now() - startedAt) });
  };

  const stopTicker = () => {
    if (ticker) clearInterval(ticker);
    ticker = null;
  };

  const stop = async (): Promise<TeachStopResult> => {
    const result = await requireRecorder().stop();
    stopTicker();
    emitState();
    if (awaiting?.id !== result.id) {
      awaiting = { id: result.id, description };
      for (const origin of result.secretOrigins) deps.offerSave(origin);
    }
    const timeline = summarizeEvents(result.events);
    return {
      id: result.id,
      timeline,
      description: awaiting.description,
      secretOrigins: result.secretOrigins,
      prompt: buildDraftPrompt(awaiting.description, timeline),
    };
  };

  return {
    available: () => deps.recorder() !== null,

    async start(text) {
      const recorder = requireRecorder();
      const trimmed = text.trim();
      if (!trimmed) throw new Error(TEACH_ERRORS.noDescription);
      // A new recording replaces one still waiting for review.
      if (awaiting) {
        await recorder.cleanup(awaiting.id).catch(() => {});
        awaiting = null;
      }
      const started = await recorder.start(trimmed);
      // The recorder owns the browser lock now and releases it when it stops.
      takenOver = false;
      description = trimmed;
      startedAt = now();
      stopTicker();
      ticker = setInterval(emitState, tickMs);
      emitState();
      return started;
    },

    pause() {
      requireRecorder().pause();
      emitState();
    },

    resume() {
      requireRecorder().resume();
      emitState();
    },

    stop,

    async handleAutoStop() {
      stopTicker();
      // Settle the review right away so the save offers show even before the renderer asks.
      await stop().catch(() => emitState());
    },

    async discard() {
      const recorder = deps.recorder();
      stopTicker();
      if (awaiting) {
        await recorder?.cleanup(awaiting.id);
        awaiting = null;
      }
      await recorder?.discard();
      emitState();
    },

    async submitDraft(markdown) {
      if (!awaiting) return { ok: false, error: TEACH_ERRORS.noReview };
      const parsed = parseDraft(markdown);
      if (parsed.ok === false) {
        deps.emitDraftRejected({ recordingId: awaiting.id, error: parsed.code });
        return { ok: false, error: parsed.error };
      }
      const { ok: _ok, ...draft } = parsed;
      deps.emitDraft({ markdown, recordingId: awaiting.id, draft });
      return { ok: true, result: 'cartão de revisão exibido' };
    },

    async saveDraft({ markdown, recordingId, name, description: edited }) {
      if (!awaiting || awaiting.id !== recordingId) throw fail('no_review');
      const submitted = parseDraft(markdown);
      if (submitted.ok === false) throw fail(submitted.code);
      // Always rewrite both as quoted scalars so the saved SKILL.md is strict-YAML safe.
      const text = withDraftDescription(
        withDraftName(markdown, name || submitted.name),
        edited ?? submitted.description
      );
      const parsed = parseDraft(text);
      if (parsed.ok === false) throw fail(parsed.code);
      // recordingId came from the recorder (a UUID) and the name passed TAUGHT_SKILL_NAME_RE.
      const skillPath = path.join(deps.dir, recordingId, 'skill', parsed.name);
      await mkdir(skillPath, { recursive: true });
      await writeFile(path.join(skillPath, 'SKILL.md'), text, 'utf8');
      const limit = deps.maxSkillBytes ? await deps.maxSkillBytes().catch((): null => null) : null;
      await copyCitedShots({
        text,
        source: path.join(deps.dir, recordingId, SHOTS_DIRNAME),
        skillPath,
        fallback: deps.shotsDir ? path.join(deps.shotsDir, parsed.name) : null,
        limit,
      });
      return { skillPath };
    },

    takeOver(on) {
      const recorder = deps.recorder();
      // The recorder holds the lock while recording; releasing it here would let the agent in.
      if (recorder && recorder.state() !== 'idle') throw new Error(TEACH_ERRORS.recording);
      const bridge = deps.bridge();
      if (!bridge) throw new Error(TEACH_ERRORS.unavailable);
      bridge.setClientsLocked(on, on ? TAKE_OVER_REASON : undefined);
      takenOver = on;
    },

    takeOverState: () => ({ on: takenOver }),
  };
}
