import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Recorder, RecorderState, RecordingResult } from '@process/services/teach/recording/recorder';
import { createTeachSession, TAKE_OVER_REASON } from '@process/services/teach/recording/teachSession';

const ID = '11111111-2222-3333-4444-555555555555';

const DRAFT = `---
name: jr-tarefa-relatorio-nfs
description: Baixa o relatório de NFs.
source: taught
created: 2026-10-29
---

## Passos
1. Abrir o portal
`;

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fakeRecorder = (result: Partial<RecordingResult> = {}) => {
  let state: RecorderState = 'idle';
  const full: RecordingResult = {
    id: ID,
    events: [{ t: 0, tab: 1, kind: 'navigate', url: 'https://portal.gov.br/login' }],
    secretOrigins: ['https://portal.gov.br'],
    ...result,
  };
  const recorder = {
    start: vi.fn(async () => {
      state = 'recording';
      return { id: full.id };
    }),
    pause: vi.fn(() => {
      state = 'paused';
    }),
    resume: vi.fn(() => {
      state = 'recording';
    }),
    stop: vi.fn(async () => {
      state = 'idle';
      return full;
    }),
    discard: vi.fn(async () => {
      state = 'idle';
    }),
    cleanup: vi.fn(async () => {}),
    recordDownload: vi.fn(),
    state: () => state,
  } satisfies Recorder;
  return recorder;
};

const setup = async (recorder: Recorder | null = fakeRecorder()) => {
  const dir = await mkdtemp(join(tmpdir(), 'teach-session-'));
  roots.push(dir);
  const setClientsLocked = vi.fn();
  const deps = {
    recorder: () => recorder,
    bridge: () => ({ setClientsLocked }),
    offerSave: vi.fn(),
    emitState: vi.fn(),
    emitDraft: vi.fn(),
    emitDraftRejected: vi.fn(),
    dir,
    now: () => 1_000,
  };
  return { session: createTeachSession(deps), deps, dir, setClientsLocked };
};

describe('teach session', () => {
  it('rejects start when recording is unavailable', async () => {
    const { session } = await setup(null);
    expect(session.available()).toBe(false);
    await expect(session.start('Baixar NFs')).rejects.toThrow(/indisponível/);
  });

  it('rejects an empty description', async () => {
    const { session } = await setup();
    await expect(session.start('   ')).rejects.toThrow();
  });

  it('stops into a review: timeline, prompt with the description and a save offer per secret origin', async () => {
    const { session, deps } = await setup();
    await session.start('Baixar NFs');
    expect(deps.emitState).toHaveBeenLastCalledWith({ state: 'recording', elapsedMs: 0 });
    const stopped = await session.stop();
    expect(stopped.id).toBe(ID);
    expect(stopped.description).toBe('Baixar NFs');
    expect(stopped.secretOrigins).toEqual(['https://portal.gov.br']);
    expect(stopped.timeline).toContain('portal.gov.br');
    expect(stopped.prompt).toContain(stopped.timeline);
    expect(stopped.prompt).toContain('Baixar NFs');
    expect(deps.offerSave).toHaveBeenCalledWith('https://portal.gov.br');
    expect(deps.emitState).toHaveBeenLastCalledWith({ state: 'idle', elapsedMs: 0 });
  });

  it('does not offer the vault save twice when stop is asked again after an auto-stop', async () => {
    const { session, deps } = await setup();
    await session.start('Baixar NFs');
    await session.handleAutoStop();
    await session.stop();
    expect(deps.offerSave).toHaveBeenCalledTimes(1);
  });

  it('only accepts a draft while a stopped recording awaits review', async () => {
    const { session, deps } = await setup();
    expect(await session.submitDraft(DRAFT)).toEqual({ ok: false, error: 'nenhuma gravação aguardando revisão' });
    await session.start('Baixar NFs');
    expect(await session.submitDraft(DRAFT)).toEqual({ ok: false, error: 'nenhuma gravação aguardando revisão' });
    await session.stop();
    expect(await session.submitDraft(DRAFT)).toEqual({ ok: true, result: 'cartão de revisão exibido' });
    expect(deps.emitDraft).toHaveBeenCalledWith({
      markdown: DRAFT,
      recordingId: ID,
      draft: expect.objectContaining({ name: 'jr-tarefa-relatorio-nfs', steps: ['Abrir o portal'] }),
    });
  });

  it('returns the validation error for an invalid draft and shows no card', async () => {
    const { session, deps } = await setup();
    await session.start('Baixar NFs');
    await session.stop();
    const result = await session.submitDraft(DRAFT.replace('## Passos', '## Etapas'));
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Passos') });
    expect(deps.emitDraft).not.toHaveBeenCalled();
    expect(deps.emitDraftRejected).toHaveBeenCalledWith({ recordingId: ID, error: 'no_steps' });
    // The event is value-free: nothing of the draft goes to the renderer.
    expect(JSON.stringify(deps.emitDraftRejected.mock.calls)).not.toContain('jr-tarefa-relatorio-nfs');
  });

  it('saves the draft as <dir>/<id>/skill/<name>/SKILL.md, applying a renamed name', async () => {
    const { session, dir } = await setup();
    await session.start('Baixar NFs');
    await session.stop();
    const { skillPath } = await session.saveDraft({
      markdown: DRAFT,
      recordingId: ID,
      name: 'jr-tarefa-nfs-prefeitura',
    });
    expect(skillPath).toBe(join(dir, ID, 'skill', 'jr-tarefa-nfs-prefeitura'));
    expect(await readFile(join(skillPath, 'SKILL.md'), 'utf8')).toContain('name: "jr-tarefa-nfs-prefeitura"');
  });

  it('applies an edited description as one frontmatter line', async () => {
    const { session } = await setup();
    await session.start('Baixar NFs');
    await session.stop();
    const { skillPath } = await session.saveDraft({
      markdown: DRAFT,
      recordingId: ID,
      description: 'Baixa as NFs\n do mês',
    });
    const saved = await readFile(join(skillPath, 'SKILL.md'), 'utf8');
    expect(saved).toContain('description: "Baixa as NFs do mês"\nsource: taught');
  });

  it('refuses to save for another recording or an invalid name', async () => {
    const { session } = await setup();
    await session.start('Baixar NFs');
    await session.stop();
    await expect(session.saveDraft({ markdown: DRAFT, recordingId: '../x' })).rejects.toThrow('no_review');
    await expect(session.saveDraft({ markdown: DRAFT, recordingId: ID, name: '../evil' })).rejects.toThrow('bad_name');
    await expect(session.saveDraft({ markdown: DRAFT, recordingId: ID, description: '  ' })).rejects.toThrow(
      'no_description'
    );
  });

  it('discard removes the awaiting recording and forgets it', async () => {
    const recorder = fakeRecorder();
    const { session } = await setup(recorder);
    await session.start('Baixar NFs');
    await session.stop();
    await session.discard();
    expect(recorder.cleanup).toHaveBeenCalledWith(ID);
    expect(recorder.discard).toHaveBeenCalled();
    expect(await session.submitDraft(DRAFT)).toEqual({ ok: false, error: 'nenhuma gravação aguardando revisão' });
  });

  it('ticks elapsed time while recording and stops ticking when idle', async () => {
    vi.useFakeTimers();
    let now = 0;
    const recorder = fakeRecorder();
    const { deps } = await setup(recorder);
    const session = createTeachSession({ ...deps, now: () => now });
    await session.start('Baixar NFs');
    now = 2_000;
    vi.advanceTimersByTime(1_000);
    expect(deps.emitState).toHaveBeenLastCalledWith({ state: 'recording', elapsedMs: 2_000 });
    session.pause();
    expect(deps.emitState).toHaveBeenLastCalledWith({ state: 'paused', elapsedMs: 2_000 });
    await session.stop();
    const calls = deps.emitState.mock.calls.length;
    vi.advanceTimersByTime(5_000);
    expect(deps.emitState.mock.calls.length).toBe(calls);
  });

  it('take-over locks the agent out with a clear reason, and is refused while recording', async () => {
    const { session, setClientsLocked } = await setup();
    expect(session.takeOverState()).toEqual({ on: false });
    session.takeOver(true);
    expect(session.takeOverState()).toEqual({ on: true });
    expect(setClientsLocked).toHaveBeenLastCalledWith(true, TAKE_OVER_REASON);
    expect(TAKE_OVER_REASON).toContain('aguarde ele devolver');
    session.takeOver(false);
    expect(setClientsLocked).toHaveBeenLastCalledWith(false, undefined);
    session.takeOver(true);
    await session.start('Baixar NFs');
    expect(session.takeOverState()).toEqual({ on: false });
    expect(() => session.takeOver(false)).toThrow();
  });
});
