import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandbookActivityBody, HandbookPayload } from '@/common/types/agent/handbookTypes';
import { LEARN_TERM_VERSION, type LearnInsightBatch, type LearnState } from '@/common/types/agent/learnTypes';
import type { HandbookClient, HandbookPublishInput } from '@process/services/jr/handbookClient';
import { createHandbookService } from '@process/services/teach/handbook/handbookService';

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

const learnWith = (acceptedVersion: string | null) => ({
  state: () => ({ acceptedVersion }) as LearnState,
  listInsights: vi.fn(async () => batches),
});

async function setup(options: { client?: Partial<HandbookClient>; accepted?: string | null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jr-handbook-'));
  roots.push(root);
  const skillsDir = join(root, 'skills');
  await mkdir(join(skillsDir, SKILL, 'telas'), { recursive: true });
  await writeFile(join(skillsDir, SKILL, 'SKILL.md'), SKILL_MD);
  await Promise.all([1, 2, 3].map((n) => writeFile(join(skillsDir, SKILL, 'telas', `${n}.jpg`), `jpeg-${n}`)));
  await mkdir(join(skillsDir, 'outra-skill'), { recursive: true });
  const fake = fakeClient(options.client);
  const learn = learnWith(options.accepted === undefined ? null : options.accepted);
  const stateFile = join(root, 'jr-handbook', 'state.json');
  const service = createHandbookService({
    client: fake.client,
    skillsDir: async () => skillsDir,
    shotsDirs: (skill, dir) => [join(dir, skill, 'telas')],
    learn: () => learn,
    stateFile,
    now: () => NOW,
  });
  return { service, ...fake, learn, stateFile, skillsDir };
}

const taughtKey = `taught:${SKILL}`;

describe('handbook service drafts', () => {
  it('lists the taught task as an activity draft with its screenshots', async () => {
    const { service } = await setup();
    const { drafts, role: current } = await service.drafts();
    expect(current).toEqual(role);
    expect(drafts.map((draft) => draft.key)).toEqual([taughtKey]);
    expect(drafts[0].shots).toEqual([1, 2, 3]);
    expect(drafts[0].status).toBe('new');
  });

  it(`learn drafts are absent unless Aprender accepted version is ${LEARN_TERM_VERSION}`, async () => {
    for (const accepted of [null, '1.2']) {
      // eslint-disable-next-line no-await-in-loop
      const { service, learn } = await setup({ accepted });
      // eslint-disable-next-line no-await-in-loop
      const { drafts } = await service.drafts();
      expect(drafts.every((draft) => draft.source === 'taught')).toBe(true);
      expect(learn.listInsights).not.toHaveBeenCalled();
    }
    const { service } = await setup({ accepted: LEARN_TERM_VERSION });
    const keys = (await service.drafts()).drafts.map((draft) => draft.key);
    expect(keys).toContain('learn:conferir banco');
    expect(keys).toContain('indicators:2026-10-26');
  });

  it('a learn draft cannot be published without the current consent', async () => {
    const { service, client } = await setup({ accepted: '1.2' });
    await expect(service.publish('learn:conferir banco', {} as HandbookActivityBody, [])).rejects.toThrow();
    expect(client.publish).not.toHaveBeenCalled();
  });

  it('a published draft with an unchanged hash is hidden; a changed source shows status changed', async () => {
    const { service, published, skillsDir } = await setup();
    const [draft] = (await service.drafts()).drafts;
    await service.publish(taughtKey, draft.body, draft.shots);
    expect((await service.drafts()).drafts).toEqual([]);
    expect((await service.drafts()).published).toEqual([
      { key: taughtKey, itemId: published[0].id, kind: 'activity', title: 'Lança a nota fiscal' },
    ]);
    await writeFile(join(skillsDir, SKILL, 'SKILL.md'), SKILL_MD.replace('3. Emitir', '3. Emitir a nota'));
    const [changed] = (await service.drafts()).drafts;
    expect(changed.status).toBe('changed');
    expect(changed.publishedItemId).toBe(published[0].id);
    await service.publish(taughtKey, changed.body, []);
    expect(published[1].id).toBe(published[0].id);
  });

  it('dismissed draft returns when its hash changes', async () => {
    const { service, skillsDir } = await setup();
    await service.dismiss(taughtKey);
    expect((await service.drafts()).drafts).toEqual([]);
    await writeFile(join(skillsDir, SKILL, 'SKILL.md'), SKILL_MD.replace('1. Abrir o portal', '1. Abrir o site'));
    expect((await service.drafts()).drafts.map((draft) => draft.key)).toEqual([taughtKey]);
  });
});

describe('handbook service publish', () => {
  it('publish sends only keepShots as media, read from telas/', async () => {
    const { service, published } = await setup();
    const [draft] = (await service.drafts()).drafts;
    await service.publish(taughtKey, draft.body, [1, 3, 7]);
    const [input] = published;
    expect(input.kind).toBe('activity');
    expect(input.source).toBe('taught');
    expect(input.media.map((media) => Buffer.from(media.base64, 'base64').toString())).toEqual(['jpeg-1', 'jpeg-3']);
    const steps = (input.body as HandbookActivityBody).steps;
    expect(steps.map((step) => Boolean(step.mediaId))).toEqual([true, false, true]);
    expect(steps[0].mediaId).toBe(input.media[0].id);
    expect(JSON.stringify(input.body)).not.toContain('"shot"');
  });

  it('applies the employee edits and ignores unknown fields', async () => {
    const { service, published } = await setup();
    const [draft] = (await service.drafts()).drafts;
    const edited = {
      ...(draft.body as HandbookActivityBody),
      title: 'Lançar NF',
      frequency: 'daily',
      steps: [{ text: 'Abrir o portal', shot: 1 }],
      authorName: 'Ana',
    } as HandbookActivityBody;
    await service.publish(taughtKey, edited, [1]);
    const body = published[0].body as Record<string, unknown>;
    expect(body.title).toBe('Lançar NF');
    expect(body.frequency).toBe('daily');
    expect(body).not.toHaveProperty('authorName');
  });

  it('publish with no_role rejects with no_role and stores nothing locally', async () => {
    const { service, stateFile } = await setup({
      client: {
        publish: vi.fn(async () => {
          throw new Error('no_role');
        }),
      },
    });
    const [draft] = (await service.drafts()).drafts;
    await expect(service.publish(taughtKey, draft.body, draft.shots)).rejects.toThrow('no_role');
    await expect(readFile(stateFile, 'utf8')).rejects.toThrow();
    expect((await service.drafts()).drafts).toHaveLength(1);
  });

  it('withdraw removes the item on the server and from the local state', async () => {
    const { service, client, published } = await setup();
    const [draft] = (await service.drafts()).drafts;
    await service.publish(taughtKey, draft.body, []);
    await service.withdraw(published[0].id);
    expect(client.remove).toHaveBeenCalledWith(published[0].id);
    expect((await service.drafts()).published).toEqual([]);
  });

  it('withdrawLearnItems calls the client and clears learn entries from state', async () => {
    const { service, client } = await setup({ accepted: LEARN_TERM_VERSION });
    const { drafts } = await service.drafts();
    for (const draft of drafts) {
      // eslint-disable-next-line no-await-in-loop
      await service.publish(draft.key, draft.body, []);
    }
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
