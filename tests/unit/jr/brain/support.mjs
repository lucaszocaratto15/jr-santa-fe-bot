import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrainServer } from '../../../../services/brain/server.mjs';

export const SECRET = 'brain-secret-test-only-not-real';

export async function startBrain(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jr-brain-test-'));
  const brain = createBrainServer({ databasePath: join(directory, 'brain.sqlite'), secret: SECRET, ...options });
  const { port } = await brain.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await brain.close();
    await rm(directory, { recursive: true, force: true });
  });
  /** Request as `user` (id, default owner) with the shared secret unless `secret` is overridden. */
  const request = (path, { method = 'GET', user = 'owner', role = 'employee', secret = SECRET, body, headers } = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(secret === null ? {} : { 'x-brain-secret': secret }),
        ...(user === null ? {} : { 'x-jr-user-id': user, 'x-jr-role': role, 'x-jr-title': 'Cargo' }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  const call = async (path, options) => {
    const response = await request(path, options);
    return { status: response.status, body: await response.json() };
  };
  const { store } = brain;
  const areas = { general: store.areas.list().find((a) => a.isGeneral).id };
  for (const name of ['Frota', 'Compras']) areas[name.toLowerCase()] = store.areas.create(name).id;
  const fact = (areaId, text, extra = {}) =>
    store.facts.insert({
      areaId,
      risk: 'low',
      kind: 'fato',
      text,
      sourceKind: 'usuario_afirmou',
      authorUserId: 'ana',
      confidence: 9,
      ...extra,
    });
  return { ...brain, directory, request, call, areas, fact, baseUrl };
}
