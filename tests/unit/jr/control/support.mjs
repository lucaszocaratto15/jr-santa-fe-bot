import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlServer } from '../../../../services/control/server.mjs';

export const ADMIN_CODE = 'jr-owner-test-only-43286acdef-901233445566778899';
export const UPSTREAM_KEY = 'upstream-test-only-not-a-real-secret';
export const MODEL = 'MiniMax-M3.1-Flash';

export async function startControl(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jr-control-test-'));
  const control = createControlServer({
    databasePath: join(directory, 'control.sqlite'),
    adminCode: ADMIN_CODE,
    upstreamUrl: 'https://bot.jrsantafe.com.br/mmx/v1',
    upstreamKey: UPSTREAM_KEY,
    model: MODEL,
    upstreamFetch: async () => Response.json({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
    ...options,
  });
  control.server.listen(0, '127.0.0.1');
  await once(control.server, 'listening');
  const baseUrl = `http://127.0.0.1:${control.server.address().port}`;
  t.after(async () => {
    await control.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path, { method = 'GET', token, body } = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (code = ADMIN_CODE, suffix = 'owner') => {
    const response = await request('/auth/login', {
      method: 'POST',
      body: { code, deviceId: `device-test-${suffix}`, deviceName: `Computador ${suffix}` },
    });
    return { response, ...(await response.json()) };
  };
  const invite = async (adminToken, name = 'Funcionário de teste') => {
    const response = await request('/admin/invites', { method: 'POST', token: adminToken, body: { name } });
    return { response, ...(await response.json()) };
  };
  return { ...control, directory, request, login, invite, baseUrl };
}
