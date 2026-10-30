import { describe, expect, it, vi } from 'vitest';
import { createBrainManageClient } from '@/process/services/brain/brainManageClient';
import { createBrainClient } from '@/process/services/jr/brainClient';

const row = {
  id: 7,
  areaId: 2,
  risk: 'low',
  kind: 'fato',
  text: 'texto',
  sourceQuote: 'trecho',
  sourceKind: 'usuario_afirmou',
  authorUserId: 'u1',
  authorBot: null,
  erpRef: null,
  createdAt: 1,
  confidence: 8,
  active: true,
  suspended: false,
  flagConflict: false,
  humanEdited: false,
  updatedBy: null,
  updatedAt: null,
};

const client = (reply: unknown) => {
  const call = vi.fn(async (_path: string, _init?: RequestInit) => reply);
  return { call, manage: createBrainManageClient(call) };
};
const failing = (failure: unknown) => createBrainManageClient(async () => Promise.reject(failure));

describe('brainManageClient', () => {
  it('builds the facts query from the filters and shape-checks the rows', async () => {
    const { call, manage } = client({ facts: [row] });
    const facts = await manage.facts({ areaId: 2, risk: 'high', suspended: true, q: ' obra ' });
    expect(facts).toHaveLength(1);
    expect(call.mock.calls[0][0]).toBe('/api/brain/manage/facts?areaId=2&risk=high&suspended=true&q=obra');
    await expect(client({ facts: [{ id: 1 }] }).manage.facts({})).rejects.toThrow('unavailable');
    await expect(client({}).manage.facts({})).rejects.toThrow('unavailable');
  });

  it('patches a fact with a JSON body and returns the updated fact', async () => {
    const { call, manage } = client({ fact: { ...row, text: 'novo' } });
    expect((await manage.updateFact(7, { text: 'novo' })).text).toBe('novo');
    const [path, init] = call.mock.calls[0];
    expect(path).toBe('/api/brain/manage/facts/7');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'novo' });
  });

  it('puts memberships, deletes by author and reads the log', async () => {
    const put = client({ memberships: [{ areaId: 2, level: 'gestor', primary: true }] });
    await put.manage.setMemberships('a b', [{ areaId: 2, level: 'gestor', primary: true }]);
    expect(put.call.mock.calls[0][0]).toBe('/api/brain/manage/members/a%20b');
    expect(put.call.mock.calls[0][1]?.method).toBe('PUT');
    const del = client({ deleted: 3 });
    expect(await del.manage.deleteAuthorFacts('u1')).toBe(3);
    expect(del.call.mock.calls[0][1]).toMatchObject({ method: 'DELETE', body: '{}' });
    const log = client({ log: [{ id: 1, at: 5, userId: 'u1', action: 'suspend', factId: null }] });
    expect(await log.manage.log(100)).toHaveLength(1);
    expect(log.call.mock.calls[0][0]).toBe('/api/brain/manage/log?since=100');
  });

  it('maps control-server failures to BRAIN_* codes', async () => {
    await expect(failing(Object.assign(new Error('JR_ACCESS_UNAVAILABLE'), { status: 400 })).facts({})).rejects.toThrow(
      'BRAIN_REJECTED'
    );
    await expect(failing(new Error('JR_ACCESS_EMPLOYEE_REVOKED')).facts({})).rejects.toThrow('BRAIN_CONFLICT');
    await expect(failing(new Error('JR_ACCESS_FORBIDDEN')).facts({})).rejects.toThrow('BRAIN_FORBIDDEN');
    await expect(failing(Object.assign(new Error('JR_ACCESS_UNAVAILABLE'), { status: 404 })).facts({})).rejects.toThrow(
      'BRAIN_NOT_FOUND'
    );
    await expect(failing(new Error('JR_ACCESS_UNAVAILABLE')).facts({})).rejects.toThrow('JR_ACCESS_UNAVAILABLE');
  });

  it('is exposed on the brain client and /me accepts numeric area ids', async () => {
    const brain = createBrainClient(async () => ({
      areas: [{ id: 2, name: 'Obras', level: 'gestor', primary: true }],
      isDirector: false,
      manages: [2],
    }));
    expect(typeof brain.manage.facts).toBe('function');
    expect(await brain.me()).toMatchObject({ manages: ['2'], areas: [{ id: '2' }] });
  });
});
