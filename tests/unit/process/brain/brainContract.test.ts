import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrainManageClient } from '@/process/services/brain/brainManageClient';
import { createBrainClient, type BrainCall } from '@/process/services/jr/brainClient';
// @ts-expect-error plain .mjs service without type declarations
import { createBrainServer } from '../../../../services/brain/server.mjs';

/**
 * Contract test: the REAL brain server driven through the desktop clients. The fake `call` emulates the
 * control server (secret + identity headers, error mapping of `authorized`), so a shape drift between
 * desktop and brain fails here instead of in production.
 */
const SECRET = 'contract-secret-test-only';

type Brain = {
  listen(port: number, host: string): Promise<{ port: number }>;
  close(): Promise<void>;
  store: any;
};

let brain: Brain;
let baseUrl = '';
let directory = '';
let areas: { general: number; obras: number };

const callAs =
  (userId: string): BrainCall =>
  async (path, init) => {
    const headers: Record<string, string> = {
      'x-brain-secret': SECRET,
      'x-jr-user-id': userId,
      'x-jr-role': 'employee',
    };
    if (init?.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path.replace(/^\/api\/brain/u, '')}`, {
      method: init?.method ?? 'GET',
      headers,
      ...(init?.body === undefined ? {} : { body: init.body as string }),
    });
    if (response.status === 403) throw new Error('JR_ACCESS_FORBIDDEN');
    if (response.status === 409) throw new Error('JR_ACCESS_EMPLOYEE_REVOKED');
    if (!response.ok) throw Object.assign(new Error('JR_ACCESS_UNAVAILABLE'), { status: response.status });
    return response.json();
  };

const clientAs = (userId: string) => createBrainClient(callAs(userId));
const insert = (text: string, extra: Record<string, unknown> = {}) =>
  brain.store.facts.insert({
    areaId: areas.obras,
    risk: 'low',
    kind: 'fato',
    text,
    sourceKind: 'usuario_afirmou',
    authorUserId: 'ana',
    confidence: 9,
    ...extra,
  }) as number;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'jr-brain-contract-'));
  brain = createBrainServer({
    databasePath: join(directory, 'brain.sqlite'),
    secret: SECRET,
    resolveAuthorization: async (identity: { userId: string }) => ({
      jrUserId: identity.userId,
      erpUserId: `erp-${identity.userId}`,
      organizationId: 'jr',
      scope: { all: true },
      publishAreaIds: brain.store.areas.list().map((area: { id: number }) => area.id),
      reviewAreaIds: brain.store.areas.list().map((area: { id: number }) => area.id),
    }),
  }) as Brain;
  const { port } = await brain.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${port}`;
  areas = {
    general: brain.store.areas.list().find((a: { isGeneral: boolean }) => a.isGeneral).id,
    obras: brain.store.areas.create('Obras').id,
  };
  brain.store.members.set('gil', [
    { areaId: areas.obras, level: 'gestor', primary: true },
    { areaId: areas.general, level: 'gestor', primary: false },
  ]);
});

afterAll(async () => {
  await brain.close();
  await rm(directory, { recursive: true, force: true });
});

describe('desktop clients against the real brain', () => {
  it('me: numeric ids and the managed set match what the manager routes allow', async () => {
    const me = await clientAs('gil').me();
    expect(me.manages).toEqual([String(areas.obras)]);
    expect(me.areas.map((a) => a.id)).toContain(String(areas.general));
    expect((await clientAs('owner').me()).isDirector).toBe(true);
  });

  it('consent: POST then GET return an ISO time', async () => {
    const client = clientAs('gil');
    expect((await client.consentState()).version).toBeNull();
    const saved = await client.consent('1.4');
    expect(saved.version).toBe('1.4');
    expect(Number.isNaN(Date.parse(saved.at as string))).toBe(false);
    expect((await client.consentState()).version).toBe('1.4');
  });

  it('search returns hits with string ids and feedback takes that id', async () => {
    const id = insert('Caminhao pipa abastece na garagem norte');
    const hits = await clientAs('gil').search('caminhao');
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(String(id));
    // A colaborador vote does not suspend; the manager's vote does.
    expect(await clientAs('gil').feedback(hits[0].id, 'errado')).toEqual({ suspended: true });
    await expect(clientAs('gil').feedback('abc')).rejects.toThrow('unavailable');
  });

  it('manage.facts lists, patches and reads history', async () => {
    const id = insert('Bomba reserva fica no galpao 2');
    const manage = createBrainManageClient(callAs('gil'));
    const facts = await manage.facts({ areaId: areas.obras, q: 'bomba' });
    expect(facts.map((f) => f.id)).toEqual([id]);
    expect(facts[0].effectiveConfidence).toBeGreaterThan(0);
    await expect(manage.updateFact(id, { text: 'Bomba reserva fica no galpao 3' })).rejects.toThrow('BRAIN_CONFLICT');
    const notes = clientAs('gil').notes;
    const draft = await notes.create({ requestId: randomUUID(), factId: id });
    const revised = await notes.revise({
      id: draft.proposal.id,
      version: draft.proposal.version,
      text: 'Bomba reserva fica no galpao 3',
      sourceQuote: draft.proposal.sourceQuote,
      areaId: areas.obras,
      kind: 'shared_note',
    });
    await notes.consent({
      id: revised.proposal.id,
      version: revised.proposal.version,
      hash: revised.proposal.hash,
      decision: 'share',
    });
    const history = await manage.history(id);
    expect(history.map((item) => item.text)).toEqual([
      'Bomba reserva fica no galpao 2',
      'Bomba reserva fica no galpao 3',
    ]);
    // Area promotion also needs the explicit version-bound consent flow.
    await expect(manage.updateFact(id, { general: true })).rejects.toThrow('BRAIN_CONFLICT');
    await expect(manage.facts({ areaId: areas.general })).rejects.toThrow('BRAIN_FORBIDDEN');
  });

  it('owner: areas CRUD, members, delete by author and log', async () => {
    const owner = createBrainManageClient(callAs('owner'));
    const created = await owner.createArea('Financeiro');
    await owner.renameArea(created.id, 'Financeiro 2');
    const list = await owner.areas();
    expect(list.find((a) => a.id === created.id)?.name).toBe('Financeiro 2');
    expect(list.find((a) => a.isGeneral)).toBeTruthy();
    const memberships = await owner.setMemberships('bia', [
      { areaId: created.id, level: 'colaborador', primary: true },
    ]);
    expect(memberships).toEqual([{ areaId: created.id, level: 'colaborador', primary: true }]);
    expect((await owner.areas()).find((a) => a.id === created.id)?.members).toEqual([
      { userId: 'bia', level: 'colaborador', primary: true },
    ]);
    insert('Fato da Ana para apagar', { authorUserId: 'ana2' });
    expect(await owner.deleteAuthorFacts('ana2')).toBe(1);
    await owner.removeArea(created.id);
    const log = await owner.log(Date.now() - 60_000);
    expect(log.map((entry) => entry.action)).toEqual(expect.arrayContaining(['set_members', 'delete_author_facts']));
    await expect(createBrainManageClient(callAs('gil')).areas()).rejects.toThrow('BRAIN_FORBIDDEN');
  });
});
