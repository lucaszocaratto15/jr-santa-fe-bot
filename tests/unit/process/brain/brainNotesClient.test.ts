import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrainNotesClient } from '@/process/services/brain/brainNotesClient';
import { createBrainService } from '@/process/services/brain/brainIpc';
import { createBrainClient } from '@/process/services/jr/brainClient';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@/process/services/teach/lessons/lessonRuntime', () => ({ vaultSecrets: vi.fn() }));
const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const draft = {
  id: 'proposal-fixture',
  version: 1,
  hash: 'fixture-hash',
  text: 'Nota de exemplo',
  sourceQuote: 'Trecho autorizado',
  areaId: 1,
  risk: 'low',
  kind: 'shared_note',
  status: 'draft',
};

describe('explicit note client', () => {
  it('sends exactly the approved excerpt and does not interpret receipt as a created proposal', async () => {
    const call = vi.fn(async () => ({ accepted: true }));
    await expect(
      createBrainNotesClient(call).create({ requestId: 'request-fixture', excerpt: 'Trecho autorizado' })
    ).rejects.toThrow('unavailable');
    const payload = JSON.parse(String(call.mock.calls[0]?.[1]?.body));
    expect(payload).toEqual({
      requestId: 'request-fixture',
      authorized: true,
      messages: [{ role: 'user', text: 'Trecho autorizado' }],
    });
  });

  it('carries the exact reviewed version and hash when sharing', async () => {
    const call = vi.fn(async (_path: string, _init?: RequestInit) => ({ proposal: draft }));
    await createBrainNotesClient(call).consent({ id: draft.id, version: 1, hash: draft.hash, decision: 'share' });
    expect(JSON.parse(String(call.mock.calls[0]?.[1]?.body))).toEqual({
      version: 1,
      hash: draft.hash,
      decision: 'share',
    });
  });
});

describe('legacy queue quarantine', () => {
  it('login, resume and legacy capture preserve old files byte-for-byte and send no excerpt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jr-brain-quarantine-'));
    paths.push(dir);
    const file = join(dir, 'queue.json');
    const original = '{"version":1,"items":[{"id":"legacy-fixture","payload":{"messages":[]}}]}';
    await writeFile(file, original);
    const call = vi.fn(async () => ({}));
    const service = createBrainService({ dir, client: createBrainClient(call), secrets: async () => [] });
    await service.bindProfile('fixture-user');
    await service.resume();
    await service.capture({
      conversationId: 'fixture-conversation',
      messages: [{ id: 'm', role: 'user', text: 'not authorized for capture' }],
    });
    expect(call).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe(original);
  });
});
