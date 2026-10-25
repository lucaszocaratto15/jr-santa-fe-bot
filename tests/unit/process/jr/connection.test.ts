import { mkdir, mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  bootstrapJrConnection,
  getJrRelayConfig,
  createJrWorkspace,
  configureJrWorkspaceContext,
  configureJrProvider,
  providersFromList,
  readLoopbackProviders,
} from '@/process/services/jr/bootstrap';
import { getJrConnectionStatus } from '@/process/services/jr/usage';

const env = {
  JR_LOCAL_PILOT: '1',
  JR_RELAY_URL: 'http://127.0.0.1:4567/v1',
  JR_RELAY_TOKEN: 'a'.repeat(64),
  JR_MINIMAX_MODEL: 'MiniMax-M3.1-Flash',
};
beforeEach(() => vi.restoreAllMocks());

it('accepts only the temporary loopback relay and never accepts incomplete configuration', () => {
  expect(getJrRelayConfig({})).toBeNull();
  expect(getJrRelayConfig(env)?.url).toBe(env.JR_RELAY_URL);
  expect(() => getJrRelayConfig({ ...env, JR_RELAY_URL: 'https://example.com/v1' })).toThrow();
  expect(() => getJrRelayConfig({ ...env, JR_RELAY_URL: 'http://127.0.0.1:4567/v1?key=secret' })).toThrow();
  expect(() => getJrRelayConfig({ ...env, JR_RELAY_TOKEN: '' })).toThrow();
});

it('registers the fixed JR provider with only the temporary token', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ success: true, data: [] }))
    .mockResolvedValueOnce(Response.json({ success: true, data: { id: 'provider' } }));
  await bootstrapJrConnection(8000, env, request);
  const body = JSON.parse(request.mock.calls[1][1].body);
  expect(body).toMatchObject({
    name: 'JR MiniMax',
    api_key: env.JR_RELAY_TOKEN,
    models: ['MiniMax-M3.1-Flash'],
    enabled: true,
  });
  expect(request.mock.calls[1][0]).toBe('http://127.0.0.1:8000/api/providers');
});

it('reenables an existing JR provider instead of leaving it disabled', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ success: true, data: [{ id: 'provider-1', name: 'JR MiniMax' }] }))
    .mockResolvedValueOnce(Response.json({ success: true, data: { id: 'provider-1' } }));
  await configureJrProvider(
    8000,
    { url: env.JR_RELAY_URL, token: env.JR_RELAY_TOKEN, model: env.JR_MINIMAX_MODEL },
    request
  );
  expect(request.mock.calls[1][0]).toBe('http://127.0.0.1:8000/api/providers/provider-1');
  expect(request.mock.calls[1][1].method).toBe('PUT');
  expect(JSON.parse(request.mock.calls[1][1].body).enabled).toBe(true);
});

it('reads a provider row without copying its key into the renderer list', async () => {
  const secret = 'c'.repeat(64);
  expect(
    providersFromList({
      success: true,
      data: [
        {
          id: 'provider-1',
          name: 'JR MiniMax',
          platform: 'openai',
          base_url: 'http://127.0.0.1:61210/v1',
          api_key: secret,
          enabled: 1,
          models: '["MiniMax-M3.1-Flash"]',
          user_id: 'system_default_user',
        },
      ],
    })
  ).toEqual([
    {
      id: 'provider-1',
      name: 'JR MiniMax',
      platform: 'openai',
      base_url: 'http://127.0.0.1:61210/v1',
      api_key: '',
      enabled: true,
      models: ['MiniMax-M3.1-Flash'],
    },
  ]);
  const request = vi.fn().mockResolvedValue(
    Response.json({
      data: [{ id: 'provider-1', name: 'JR MiniMax', models: ['MiniMax-M3.1-Flash'], api_key: secret }],
    })
  );
  const listed = await readLoopbackProviders(61215, request);
  expect(listed[0]?.api_key).toBe('');
  expect(JSON.stringify(listed)).not.toContain(secret);
  expect(request.mock.calls[0][0]).toBe('http://127.0.0.1:61215/api/providers');
});

it('reports unavailable usage as null and keeps source tokens out of the renderer status', async () => {
  expect(await getJrConnectionStatus({})).toEqual({ connected: false, model: null, usage: null });
  const request = vi.fn().mockResolvedValue(Response.json({ model: 'MiniMax-M3.1-Flash', usage: null }));
  const status = await getJrConnectionStatus(env, request);
  expect(status).toEqual({ connected: true, model: 'MiniMax-M3.1-Flash', usage: null });
  expect(JSON.stringify(status)).not.toContain(env.JR_RELAY_TOKEN);
});

it('reports fallback mode only from an explicit boolean and hides provider secrets', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ model: 'MiniMax-M3.1-Flash', usage: null, fallback: true }))
    .mockResolvedValueOnce(Response.json({ model: 'MiniMax-M3.1-Flash', usage: null, fallback: env.JR_RELAY_TOKEN }));
  expect(await getJrConnectionStatus(env, request)).toEqual({
    connected: true,
    model: 'MiniMax-M3.1-Flash',
    usage: null,
    fallback: true,
  });
  const ignored = await getJrConnectionStatus(env, request);
  expect(ignored).toEqual({ connected: true, model: 'MiniMax-M3.1-Flash', usage: null });
  expect(JSON.stringify(ignored)).not.toContain(env.JR_RELAY_TOKEN);
});

it('rejects fabricated or malformed usage values instead of showing zero', async () => {
  const request = vi.fn().mockResolvedValue(
    Response.json({
      model: 'MiniMax-M3.1-Flash',
      usage: {
        startedAt: '2026-10-22T15:00:00Z',
        promptTokens: -1,
        completionTokens: 9,
        cachedPromptTokens: 0,
        modelRequests: 1,
      },
    })
  );
  await expect(getJrConnectionStatus(env, request)).rejects.toThrow();
});

it('creates separate private workspaces inside the application profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jr-workspace-'));
  try {
    const first = await createJrWorkspace(root),
      second = await createJrWorkspace(root);
    expect(first).not.toBe(second);
    expect(first.startsWith(join(root, 'jr-workspaces') + sep)).toBe(true);
    expect((await stat(first)).isDirectory()).toBe(true);
    expect(await readFile(join(first, '.aionrs.toml'), 'utf8')).toContain('autocompact_threshold_pct = 55');
    if (process.platform !== 'win32') expect((await stat(join(first, '.aionrs.toml'))).mode & 0o777).toBe(0o600);
    if (process.platform !== 'win32') expect((await stat(first)).mode & 0o777).toBe(0o700);
    await expect(createJrWorkspace('relative')).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves a workspace-owned AionRS config and rejects workspaces outside the app profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jr-workspace-config-'));
  const workspace = join(root, 'jr-workspaces', 'bot-one');
  const original = '[compact]\ncontext_window = 160000\n';
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, '.aionrs.toml'), original);
    await configureJrWorkspaceContext(root, workspace);
    expect(await readFile(join(workspace, '.aionrs.toml'), 'utf8')).toBe(original);
    await expect(configureJrWorkspaceContext(root, root)).rejects.toThrow('Invalid local workspace path');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not activate a development relay unless local pilot mode is explicit', () => {
  expect(getJrRelayConfig({ ...env, JR_LOCAL_PILOT: undefined })).toBeNull();
});

it('never stores a remote service session directly in the renderer-visible provider catalog', async () => {
  const request = vi.fn();
  await expect(
    configureJrProvider(
      8000,
      { url: 'https://company.example/v1', token: 'a'.repeat(64), model: 'MiniMax-M3.1-Flash' },
      request
    )
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
