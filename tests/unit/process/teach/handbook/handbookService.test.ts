import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandbookActivityBody, HandbookPayload } from '@/common/types/agent/handbookTypes';
import type { LearnInsightBatch, LearnState } from '@/common/types/agent/learnTypes';
import type { Lesson } from '@/common/types/agent/lessonTypes';
import type { HandbookClient, HandbookPublishInput } from '@process/services/jr/handbookClient';
import { MAX_PUBLISH_MEDIA_BYTES, createHandbookService } from '@process/services/teach/handbook/handbookService';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 29, 15);
const SKILL = 'jr-tarefa-lancar-nf';
const SKILL_MD = `---
name: "${SKILL}"
description: "Lança a nota fiscal"
source: taught
---

## Passos
1. Abrir o portal [tela 1]
2. Entrar [tela 2]
3. Emitir [tela 3]

## Confirmar antes de
- Valor da nota
`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const role = { key: 'auxiliar de escritorio', title: 'Auxiliar de escritório' };
const emptyPayload: HandbookPayload = { role, items: [], indicators: null };

const fakeClient = (overrides: Partial<HandbookClient> = {}) => {
  const published: HandbookPublishInput[] = [];
  const client: HandbookClient = {
    mine: vi.fn(async () => emptyPayload),
    publish: vi.fn(async (input: HandbookPublishInput) => {
      published.push(input);
      return { id: input.id };
    }),
    remove: vi.fn(async () => {}),
    withdrawLearn: vi.fn(async () => {}),
    media: vi.fn(async () => ({ mime: 'image/jpeg', base64: 'AAAA' })),
    adminRoles: vi.fn(async () => []),
    adminRole: vi.fn(async () => emptyPayload),
    ...overrides,
  };
  return { client, published };
};

const batches: LearnInsightBatch[] = [
  {
    id: 'b1',
    createdAt: NOW - DAY,
    periodStart: NOW - 2 * DAY,
    periodEnd: NOW - DAY,
    timePerApp: [{ app: 'Excel', minutes: 90 }],
    repetitive: [{ title: 'Conferir banco', description: 'Confere extratos', times: 3, minutes: 30 }],
    suggestions: [],
  },
];

/** Any non-null value: the handbook service must not gate publishing on Aprender's state. */
const LEARN_TERM_VERSION = '1.3';

const learnWith = (acceptedVersion: string | null) => ({
  state: () => ({ acceptedVersion }) as LearnState,
  listInsights: vi.fn(async () => batches),
});

async function setup(
  options: {
    client?: Partial<HandbookClient>;
    accepted?: string | null;
    maxPublishMediaBytes?: number;
    lessons?: Lesson[];
    lessonsFor?: (skill: string) => Promise<Lesson[]>;
    onPublished?: (count: number) => void;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'jr-handbook-'));
  roots.push(root);
  const skillsDir = join(root, 'skills');
  await mkdir(join(skillsDir, SKILL, 'telas'), { recursive: true });
  await writeFile(join(skillsDir, SKILL, 'SKILL.md'), SKILL_MD);
  await Promise.all([1, 2, 3].map((n) => writeFile(join(skillsDir, SKILL, 'telas', `${n}.jpg`), `jpeg-${n}`)));
  await mkdir(join(skillsDir, 'outra-skill'), { recursive: true });
  const fake = fakeClient(options.client);
  // Without `accepted` there is no Aprender service at all; with it, the value must not gate anything.
  const learn = learnWith(options.accepted ?? null);
  const learnService = options.accepted === undefined ? null : learn;
  const stateFile = join(root, 'jr-handbook', 'state.json');
  const service = createHandbookService({
    client: fake.client,
    skillsDir: async () => skillsDir,
    shotsDirs: (skill, dir) => [join(dir, skill, 'telas')],
    learn: () => learnService,
    ...(options.lessons ? { lessonsFor: async () => options.lessons ?? [] } : {}),
    ...(options.lessonsFor ? { lessonsFor: options.lessonsFor } : {}),
    stateFile,
    now: () => NOW,
    ...(options.onPublished ? { onPublished: options.onPublished } : {}),
    ...(options.maxPublishMediaBytes === undefined ? {} : { maxPublishMediaBytes: options.maxPublishMediaBytes }),
  });
  return { service, ...fake, learn, stateFile, skillsDir };
}

const taughtKey = `taught:${SKILL}`;

const itemOf = async (service: Awaited<ReturnType<typeof setup>>['service'], key: string) =>
  (await service.drafts()).published.find((entry) => entry.key === key);

const itemBody = async (service: Awaited<ReturnType<typeof setup>>['service']) =>
  (await itemOf(service, taughtKey))?.draft?.body;

describe('handbook service automatic publishing', () => {
  it('publishes a new taught task without any user action, with all its screenshots', async () => {
    const { service, published, client } = await setup();
    await expect(service.syncPublish()).resolves.toBe(1);
    expect(client.publish).toHaveBeenCalledTimes(1);
    const [input] = published;
    expect(input.kind).toBe('activity');
    expect(input.source).toBe('taught');
    expect(input.media.map((media) => Buffer.from(media.base64, 'base64').toString())).toEqual([
      'jpeg-1',
      'jpeg-2',
      'jpeg-3',
    ]);
    expect(JSON.stringify(input.body)).not.toContain('"shot"');
    expect(await itemOf(service, taughtKey)).toMatchObject({ itemId: input.id, kind: 'activity' });
    expect((await service.drafts()).role).toEqual(role);
  });

  it('does not republish an unchanged item and republishes a changed source under the same id', async () => {
    const { service, published, skillsDir } = await setup();
    await service.syncPublish();
    await expect(service.syncPublish()).resolves.toBe(0);
    expect(published).toHaveLength(1);
    await writeFile(join(skillsDir, SKILL, 'SKILL.md'), SKILL_MD.replace('3. Emitir', '3. Emitir a nota'));
    await expect(service.syncPublish()).resolves.toBe(1);
    expect(published).toHaveLength(2);
    expect(published[1].id).toBe(published[0].id);
  });

  it('publishes observed items and indicators without any Aprender consent gate', async () => {
    for (const accepted of [null, '1.2', LEARN_TERM_VERSION]) {
      // eslint-disable-next-line no-await-in-loop
      const { service, published } = await setup({ accepted });
      // eslint-disable-next-line no-await-in-loop
      await service.syncPublish();
      expect(published.map((input) => input.source)).toEqual(['taught', 'learn', 'learn']);
      expect(published.map((input) => input.kind)).toEqual(['activity', 'activity', 'indicators']);
    }
  });

  it('notifies once per sync that published something, and stays silent otherwise', async () => {
    const onPublished = vi.fn();
    const { service } = await setup({ onPublished, accepted: null });
    await service.syncPublish();
    expect(onPublished).toHaveBeenCalledTimes(1);
    expect(onPublished).toHaveBeenCalledWith(3);
    await service.syncPublish();
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it('offline: nothing is stored, the sync does not throw and the next sync retries', async () => {
    let offline = true;
    const publish = vi.fn(async (input: HandbookPublishInput) => {
      if (offline) throw new Error('unavailable');
      return { id: input.id };
    });
    const onPublished = vi.fn();
    const { service, stateFile } = await setup({ client: { publish }, onPublished, accepted: null });
    await expect(service.syncPublish()).resolves.toBe(0);
    // Offline stops the sync at the first item instead of timing out on every one.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(onPublished).not.toHaveBeenCalled();
    await expect(readFile(stateFile, 'utf8')).rejects.toThrow();
    offline = false;
    await expect(service.syncPublish()).resolves.toBe(3);
    expect(onPublished).toHaveBeenCalledWith(3);
  });

  it('no_role is silent too and an item that fails otherwise does not block the rest', async () => {
    const noRole = await setup({
      client: {
        publish: vi.fn(async () => {
          throw new Error('no_role');
        }),
      },
    });
    await expect(noRole.service.syncPublish()).resolves.toBe(0);
    expect(noRole.client.publish).toHaveBeenCalledTimes(1);
    const tooLarge = await setup({
      accepted: null,
      client: {
        publish: vi.fn(async (input: HandbookPublishInput) => {
          if (input.source === 'taught') throw new Error('too_large');
          return { id: input.id };
        }),
      },
    });
    await expect(tooLarge.service.syncPublish()).resolves.toBe(2);
  });

  it('concurrent syncs share one run', async () => {
    const { service, client } = await setup({ accepted: null });
    const counts = await Promise.all([service.syncPublish(), service.syncPublish()]);
    expect(counts).toEqual([3, 3]);
    expect(client.publish).toHaveBeenCalledTimes(3);
  });

  it('requestSync is fire-and-forget and publishes', async () => {
    const onPublished = vi.fn();
    const { service } = await setup({ onPublished, accepted: null });
    service.requestSync();
    await vi.waitFor(() => expect(onPublished).toHaveBeenCalledWith(3));
  });
});

describe('handbook service edit and hide', () => {
  it('the editor opens the source and, after an edit, the edited body, which survives source changes', async () => {
    const { service, published, skillsDir } = await setup();
    await service.syncPublish();
    const entry = await itemOf(service, taughtKey);
    expect(entry?.draft?.shots).toEqual([1, 2, 3]);
    const source = entry?.draft?.body as HandbookActivityBody;
    await service.publish(
      taughtKey,
      { ...source, title: 'Lançar NF', steps: [{ text: 'Abrir o portal', shot: 1 }] },
      [1]
    );
    expect(published).toHaveLength(2);
    expect(published[1].id).toBe(published[0].id);
    expect((published[1].body as HandbookActivityBody).title).toBe('Lançar NF');
    const edited = (await itemBody(service)) as HandbookActivityBody;
    expect(edited.title).toBe('Lançar NF');
    // The edit does not make the unchanged source republish over it.
    await expect(service.syncPublish()).resolves.toBe(0);
    expect(published).toHaveLength(2);
    // A source change keeps the employee's edit on top of the new source.
    await writeFile(join(skillsDir, SKILL, 'SKILL.md'), SKILL_MD.replace('3. Emitir', '3. Emitir a nota'));
    await service.syncPublish();
    expect(published).toHaveLength(3);
    expect((published[2].body as HandbookActivityBody).title).toBe('Lançar NF');
    expect(((await itemBody(service)) as HandbookActivityBody).title).toBe('Lançar NF');
  });

  it('hiding withdraws the item and keeps it hidden until its source changes', async () => {
    const { service, client, published, skillsDir } = await setup();
    await service.syncPublish();
    await service.hide(taughtKey);
    expect(client.remove).toHaveBeenCalledWith(published[0].id);
    let result = await service.drafts();
    expect(result.published).toEqual([]);
    expect(result.hidden).toEqual([{ key: taughtKey, kind: 'activity', title: 'Lança a nota fiscal' }]);
    await expect(service.syncPublish()).resolves.toBe(0);
    expect(published).toHaveLength(1);
    // Source changes: published again and no longer listed as hidden.
    await writeFile(join(skillsDir, SKILL, 'SKILL.md'), SKILL_MD.replace('1. Abrir o portal', '1. Abrir o site'));
    await expect(service.syncPublish()).resolves.toBe(1);
    result = await service.drafts();
    expect(result.hidden).toEqual([]);
    expect(result.published.map((entry) => entry.key)).toEqual([taughtKey]);
  });

  it('a hide that cannot reach the server leaves the item published', async () => {
    const { service } = await setup({
      client: {
        remove: vi.fn(async () => {
          throw new Error('unavailable');
        }),
      },
    });
    await service.syncPublish();
    await expect(service.hide(taughtKey)).rejects.toThrow('unavailable');
    expect((await service.drafts()).published.map((entry) => entry.key)).toEqual([taughtKey]);
    expect((await service.drafts()).hidden).toEqual([]);
  });

  it('showing a hidden item again publishes it without announcing it', async () => {
    const onPublished = vi.fn();
    const { service, published } = await setup({ onPublished });
    await service.syncPublish();
    await service.hide(taughtKey);
    onPublished.mockClear();
    await service.unhide(taughtKey);
    expect(published).toHaveLength(2);
    expect(published[1].id).not.toBe('');
    expect((await service.drafts()).hidden).toEqual([]);
    expect((await itemOf(service, taughtKey))?.itemId).toBe(published[1].id);
    expect(onPublished).not.toHaveBeenCalled();
  });
});

const lesson = (text: string): Lesson =>
  ({
    id: text,
    text,
    scope: { kind: 'task', skill: SKILL },
    active: true,
    versions: [],
    createdAt: 1,
  }) as unknown as Lesson;

describe('handbook service task lessons', () => {
  it('publishes the active lesson texts and omits the field when there are none', async () => {
    const withLessons = await setup({ lessons: [lesson('Usar o CNPJ da matriz'), lesson('Conferir o valor')] });
    await withLessons.service.syncPublish();
    expect((withLessons.published[0].body as HandbookActivityBody).lessons).toEqual([
      'Usar o CNPJ da matriz',
      'Conferir o valor',
    ]);
    const none = await setup({ lessons: [] });
    await none.service.syncPublish();
    expect('lessons' in none.published[0].body).toBe(false);
  });

  it('keeps the taught item, without lessons, when the lesson store cannot be read', async () => {
    const broken = await setup({
      lessonsFor: async () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
    });
    await broken.service.syncPublish();
    expect(broken.published[0].source).toBe('taught');
    expect('lessons' in broken.published[0].body).toBe(false);
  });

  it('a new lesson republishes the item, and an edit can never forge lessons', async () => {
    const lessons: Lesson[] = [];
    const { service, published } = await setup({ lessonsFor: async () => lessons });
    await service.syncPublish();
    lessons.push(lesson('A'));
    await expect(service.syncPublish()).resolves.toBe(1);
    expect((published[1].body as HandbookActivityBody).lessons).toEqual(['A']);
    const source = (await itemOf(service, taughtKey))?.draft?.body as HandbookActivityBody;
    await service.publish(taughtKey, { ...source, lessons: ['forged'] }, []);
    expect((published[2].body as HandbookActivityBody).lessons).toEqual(['A']);
  });
});

describe('handbook service publish of an edit', () => {
  const source = async (service: Awaited<ReturnType<typeof setup>>['service']) =>
    (await itemOf(service, taughtKey))?.draft?.body as HandbookActivityBody;

  it('sends only keepShots as media, read from telas/', async () => {
    const { service, published } = await setup();
    await service.syncPublish();
    await service.publish(taughtKey, await source(service), [1, 3, 7]);
    const input = published[1];
    expect(input.media.map((media) => Buffer.from(media.base64, 'base64').toString())).toEqual(['jpeg-1', 'jpeg-3']);
    const steps = (input.body as HandbookActivityBody).steps;
    expect(steps.map((step) => Boolean(step.mediaId))).toEqual([true, false, true]);
    expect(steps[0].mediaId).toBe(input.media[0].id);
    expect(JSON.stringify(input.body)).not.toContain('"shot"');
  });

  it('keeps the images of a publish under the media budget and sends the rest of the steps as text', async () => {
    // Each fixture shot is 6 bytes: a 12-byte budget holds the first two.
    const { service, published } = await setup({ maxPublishMediaBytes: 12 });
    await service.syncPublish();
    const [input] = published;
    expect(input.media.map((media) => Buffer.from(media.base64, 'base64').toString())).toEqual(['jpeg-1', 'jpeg-2']);
    const steps = (input.body as HandbookActivityBody).steps;
    expect(steps.map((step) => Boolean(step.mediaId))).toEqual([true, true, false]);
    expect(steps.map((step) => step.text)).toHaveLength(3);
  });

  it('the default media budget is 4 MB, under the 6 MB server cap', () => {
    expect(MAX_PUBLISH_MEDIA_BYTES).toBe(4 * 1024 * 1024);
  });

  it('applies the employee edits and ignores unknown fields', async () => {
    const { service, published } = await setup();
    await service.syncPublish();
    const edited = {
      ...(await source(service)),
      title: 'Lançar NF',
      frequency: 'daily',
      steps: [{ text: 'Abrir o portal', shot: 1 }],
      authorName: 'Ana',
    } as HandbookActivityBody;
    await service.publish(taughtKey, edited, [1]);
    const body = published[1].body as Record<string, unknown>;
    expect(body.title).toBe('Lançar NF');
    expect(body.frequency).toBe('daily');
    expect(body).not.toHaveProperty('authorName');
  });

  it('a refused edit rejects and keeps the previous state', async () => {
    let refuse = false;
    const publish = vi.fn(async (input: HandbookPublishInput) => {
      if (refuse) throw new Error('no_role');
      return { id: input.id };
    });
    const { service } = await setup({ client: { publish } });
    await service.syncPublish();
    const before = await source(service);
    refuse = true;
    await expect(service.publish(taughtKey, { ...before, title: 'Outro' }, [])).rejects.toThrow('no_role');
    expect(((await itemBody(service)) as HandbookActivityBody).title).toBe(before.title);
  });

  it('withdraw removes the item on the server and from the local state', async () => {
    const { service, client, published } = await setup();
    await service.syncPublish();
    await service.withdraw(published[0].id);
    expect(client.remove).toHaveBeenCalledWith(published[0].id);
    expect((await service.drafts()).published).toEqual([]);
  });

  it('withdrawLearnItems calls the client and clears learn entries from state', async () => {
    const { service, client } = await setup({ accepted: LEARN_TERM_VERSION });
    await service.syncPublish();
    expect((await service.drafts()).published).toHaveLength(3);
    await service.withdrawLearnItems();
    expect(client.withdrawLearn).toHaveBeenCalledTimes(1);
    expect((await service.drafts()).published.map((entry) => entry.key)).toEqual([taughtKey]);
  });

  it('a revoke that cannot reach the server is retried on the next call', async () => {
    let offline = true;
    const withdrawLearn = vi.fn(async () => {
      if (offline) throw new Error('unavailable');
    });
    const { service } = await setup({ client: { withdrawLearn } });
    await expect(service.withdrawLearnItems()).rejects.toThrow('unavailable');
    offline = false;
    await service.mine();
    expect(withdrawLearn).toHaveBeenCalledTimes(2);
    await service.mine();
    expect(withdrawLearn).toHaveBeenCalledTimes(2);
  });
});

describe('handbook service pending withdraw retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const offlineWithdraw = () => {
    const control = { offline: true };
    const withdrawLearn = vi.fn(async () => {
      if (control.offline) throw new Error('unavailable');
    });
    return { control, withdrawLearn };
  };

  const pendingFlag = async (stateFile: string): Promise<boolean> =>
    JSON.parse(await readFile(stateFile, 'utf8')).pendingWithdrawLearn === true;

  it('startup retries a pending withdraw without any drafts or mine call', async () => {
    const { control, withdrawLearn } = offlineWithdraw();
    const { service, client, stateFile } = await setup({ client: { withdrawLearn } });
    await expect(service.withdrawLearnItems()).rejects.toThrow('unavailable');
    control.offline = false;
    const stop = service.startSync();
    await vi.waitFor(() => expect(withdrawLearn).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect(await pendingFlag(stateFile)).toBe(false));
    stop();
    expect(client.mine).not.toHaveBeenCalled();
  });

  it('a restored login retries a pending withdraw and clears the learn entries', async () => {
    const { control, withdrawLearn } = offlineWithdraw();
    const { service, client, stateFile } = await setup({ accepted: LEARN_TERM_VERSION, client: { withdrawLearn } });
    await service.syncPublish();
    await expect(service.withdrawLearnItems()).rejects.toThrow('unavailable');
    control.offline = false;
    const mineCalls = vi.mocked(client.mine).mock.calls.length;
    await service.retryPendingWithdraw();
    expect(withdrawLearn).toHaveBeenCalledTimes(2);
    expect(await pendingFlag(stateFile)).toBe(false);
    expect(vi.mocked(client.mine).mock.calls.length).toBe(mineCalls);
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    expect(Object.keys(state.published)).toEqual([taughtKey]);
  });

  it('retries hourly while a withdraw is pending and stops once it succeeds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { control, withdrawLearn } = offlineWithdraw();
    const { service, stateFile } = await setup({ client: { withdrawLearn } });
    const stop = service.startSync(3_600_000);
    await expect(service.withdrawLearnItems()).rejects.toThrow('unavailable');
    expect(withdrawLearn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await vi.waitFor(() => expect(withdrawLearn).toHaveBeenCalledTimes(2));
    control.offline = false;
    await vi.advanceTimersByTimeAsync(3_600_000);
    await vi.waitFor(() => expect(withdrawLearn).toHaveBeenCalledTimes(3));
    await vi.waitFor(async () => expect(await pendingFlag(stateFile)).toBe(false));
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(withdrawLearn).toHaveBeenCalledTimes(3);
    stop();
    await service.syncPublish();
  });

  it('auto-publishes on every interval, retrying what failed offline', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let offline = true;
    const publish = vi.fn(async (input: HandbookPublishInput) => {
      if (offline) throw new Error('unavailable');
      return { id: input.id };
    });
    const { service } = await setup({ client: { publish }, accepted: null });
    const stop = service.startSync(3_600_000);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    offline = false;
    await vi.advanceTimersByTimeAsync(3_600_000);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(4));
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(publish).toHaveBeenCalledTimes(4);
    stop();
    await service.syncPublish();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('handbook service stable identity, edit reapply, scrubbing and failures', () => {
  const batch = (id: string, minutes: number, times: number): LearnInsightBatch => ({
    id,
    createdAt: NOW - DAY,
    periodStart: NOW - 2 * DAY,
    periodEnd: NOW - DAY,
    timePerApp: [{ app: 'Excel', minutes }],
    repetitive: [{ title: 'Conferir banco', description: 'Confere extratos', times, minutes }],
    suggestions: [],
  });

  async function withBatches() {
    const current = { list: [batch('b1', 30, 3)] };
    const setupResult = await setup({ accepted: LEARN_TERM_VERSION });
    setupResult.learn.listInsights.mockImplementation(async () => current.list);
    return { ...setupResult, current };
  }

  it('a new batch that only changes counts does not overwrite an edit, un-hide, or notify', async () => {
    const onPublished = vi.fn();
    const root = await withBatches();
    const service = createHandbookService({
      client: root.client,
      skillsDir: async () => root.skillsDir,
      shotsDirs: (skill, dir) => [join(dir, skill, 'telas')],
      learn: () => root.learn,
      stateFile: root.stateFile,
      now: () => NOW,
      onPublished,
    });
    await service.syncPublish();
    const learnKey = 'learn:conferir banco';
    const entry = (await service.drafts()).published.find((item) => item.key === learnKey);
    const body = entry?.draft?.body as HandbookActivityBody;
    await service.publish(learnKey, { ...body, title: 'Minha conferência' }, []);
    const afterEdit = root.published.length;
    onPublished.mockClear();
    root.current.list = [batch('b1', 30, 3), batch('b2', 45, 4)];
    await service.syncPublish();
    // Only the unedited weekly indicators refresh, silently.
    expect(root.published.length).toBe(afterEdit + 1);
    expect(onPublished).not.toHaveBeenCalled();
    const kept = (await service.drafts()).published.find((item) => item.key === learnKey);
    expect((kept?.draft?.body as HandbookActivityBody).title).toBe('Minha conferência');
    // Hidden stays hidden across a counts-only change.
    await service.hide(learnKey);
    root.current.list = [batch('b1', 30, 3), batch('b2', 45, 4), batch('b3', 10, 1)];
    await service.syncPublish();
    expect((await service.drafts()).hidden.map((item) => item.key)).toContain(learnKey);
    expect(onPublished).not.toHaveBeenCalled();
  });

  it('re-applies the employee edit on top of a changed taught source, with the new lesson', async () => {
    const lessons: Lesson[] = [];
    const { service, published } = await setup({ lessonsFor: async () => lessons });
    await service.syncPublish();
    const body = (await itemBody(service)) as HandbookActivityBody;
    await service.publish(
      taughtKey,
      { ...body, title: 'Lançar NF', description: 'Minha descrição', confirmBefore: ['Conferir CNPJ'] },
      [1, 2, 3]
    );
    lessons.push(lesson('Sempre conferir o valor'));
    await expect(service.syncPublish()).resolves.toBe(1);
    const last = published.at(-1)?.body as HandbookActivityBody;
    expect(last.title).toBe('Lançar NF');
    expect(last.description).toBe('Minha descrição');
    expect(last.confirmBefore).toEqual(['Conferir CNPJ']);
    expect(last.lessons).toEqual(['Sempre conferir o valor']);
    expect(last.skillName).toBe(SKILL);
  });

  it('scrubs secrets from every text field on auto publish and on edits', async () => {
    const { service, published, skillsDir } = await setup({ lessons: [lesson('Usar a senha: abc123 do portal')] });
    await writeFile(
      join(skillsDir, SKILL, 'SKILL.md'),
      SKILL_MD.replace('1. Abrir o portal', '1. Mandar para joao@empresa.com.br').replace(
        '- Valor da nota',
        '- CPF 111.444.777-35 e cartão 4539 1488 0343 6467'
      )
    );
    await service.syncPublish();
    const first = JSON.stringify(published[0].body);
    for (const secret of ['joao@empresa', '111.444.777-35', '4539 1488', 'abc123']) {
      expect(first).not.toContain(secret);
    }
    expect(first).toContain('[removido]');
    const body = (await itemBody(service)) as HandbookActivityBody;
    await service.publish(
      taughtKey,
      { ...body, title: 'Token sk-abcdefghijklmnop1234 aqui', description: 'CNPJ 11.222.333/0001-81' },
      []
    );
    const edited = JSON.stringify(published.at(-1)?.body);
    expect(edited).not.toContain('sk-abcdefghijklmnop1234');
    expect(edited).not.toContain('11.222.333/0001-81');
  });

  it('a permanent failure is not retried until the source changes', async () => {
    const publish = vi.fn(async (input: HandbookPublishInput) => {
      if (input.source === 'taught') throw new Error('too_large');
      return { id: input.id };
    });
    const { service, skillsDir } = await setup({ client: { publish }, accepted: null });
    await service.syncPublish();
    const calls = publish.mock.calls.length;
    await service.syncPublish();
    expect(publish.mock.calls.length).toBe(calls);
    await writeFile(join(skillsDir, SKILL, 'SKILL.md'), SKILL_MD.replace('3. Emitir', '3. Emitir a nota'));
    await service.syncPublish();
    expect(publish.mock.calls.length).toBe(calls + 1);
  });

  it('skips observed items while an Aprender withdrawal is pending', async () => {
    const withdrawLearn = vi.fn(async () => {
      throw new Error('unavailable');
    });
    const { service, published } = await setup({ accepted: LEARN_TERM_VERSION, client: { withdrawLearn } });
    await expect(service.withdrawLearnItems()).rejects.toThrow('unavailable');
    await service.syncPublish();
    expect(published.map((input) => input.source)).toEqual(['taught']);
  });

  it('withdraw of a known item hides it so the next sync does not publish it again', async () => {
    const { service, published } = await setup();
    await service.syncPublish();
    await service.withdraw(published[0].id);
    await expect(service.syncPublish()).resolves.toBe(0);
    expect((await service.drafts()).hidden.map((item) => item.key)).toEqual([taughtKey]);
  });

  it('the Manual opens offline from local state once a role was seen', async () => {
    let offline = false;
    const mine = vi.fn(async () => {
      if (offline) throw new Error('unavailable');
      return emptyPayload;
    });
    const { service } = await setup({ client: { mine } });
    await service.syncPublish();
    await service.drafts();
    offline = true;
    const result = await service.drafts();
    expect(result.role).toEqual(role);
    expect(result.published.map((entry) => entry.key)).toEqual([taughtKey]);
  });
});

describe('handbook service reads', () => {
  it('mine adds the role and activity flowcharts', async () => {
    const item = {
      id: '11111111-2222-4333-8444-555555555555',
      kind: 'activity' as const,
      source: 'taught' as const,
      body: {
        title: 'Lançar NF',
        description: '',
        frequency: 'daily' as const,
        steps: [{ text: 'Abrir' }],
        confirmBefore: [],
      },
      approvedAt: 1,
      updatedAt: 1,
      media: [],
    };
    const { service } = await setup({ client: { mine: vi.fn(async () => ({ ...emptyPayload, items: [item] })) } });
    const view = await service.mine();
    expect(view.roleFlowchart).toContain('Auxiliar de escritório');
    expect(view.flowcharts[item.id]).toContain('1. Abrir');
  });

  it('media comes back as a JPEG data URL; draft shots only for cited shots', async () => {
    const { service } = await setup();
    await expect(service.media('x')).resolves.toBe('data:image/jpeg;base64,AAAA');
    const shot = await service.draftShot(taughtKey, 2);
    expect(Buffer.from(shot.split(',')[1], 'base64').toString()).toBe('jpeg-2');
    await expect(service.draftShot(taughtKey, 9)).rejects.toThrow('not_found');
  });
});
