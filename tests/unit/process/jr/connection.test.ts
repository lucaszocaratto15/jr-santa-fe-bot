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

it('lets the read-only bot tools run without a prompt but keeps vault_fill asking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jr-workspace-tools-'));
  try {
    const config = await readFile(join(await createJrWorkspace(root), '.aionrs.toml'), 'utf8');
    const allow = config.match(/^allow_list = \[(.*)\]$/m)?.[1] ?? '';
    for (const tool of [
      '"brain_search"',
      '"handbook_lookup"',
      '"mcp__jr-teach__brain_search"',
      '"Read"',
      '"ToolSearch"',
    ])
      expect(allow).toContain(tool);
    expect(allow).not.toContain('vault_fill');
    expect(config).toContain('autocompact_threshold_pct = 55');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('upgrades only the exact config an older app version wrote', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jr-workspace-upgrade-'));
  const legacy = [
    '# Gerenciado pelo JR Bot: compacte o contexto antes do limite do provedor.',
    '[compact]',
    'enabled = true',
    'context_window = 200000',
    'autocompact_threshold_pct = 55',
    '',
  ].join('\n');
  try {
    const old = join(root, 'jr-workspaces', 'old-bot');
    const edited = join(root, 'jr-workspaces', 'edited-bot');
    await mkdir(old, { recursive: true });
    await mkdir(edited, { recursive: true });
    await writeFile(join(old, '.aionrs.toml'), legacy);
    await writeFile(join(edited, '.aionrs.toml'), `${legacy}# mine\n`);
    await configureJrWorkspaceContext(root, old);
    await configureJrWorkspaceContext(root, edited);
    expect(await readFile(join(old, '.aionrs.toml'), 'utf8')).toContain('"brain_search"');
    const v1 = (await readFile(join(old, '.aionrs.toml'), 'utf8')).replace(', "ToolSearch"', '');
    await writeFile(join(old, '.aionrs.toml'), v1);
    await configureJrWorkspaceContext(root, old);
    expect(await readFile(join(old, '.aionrs.toml'), 'utf8')).toContain('"ToolSearch"');
    expect(await readFile(join(edited, '.aionrs.toml'), 'utf8')).toBe(`${legacy}# mine\n`);
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

it('Strata client keeps credentials out of status and rejects inconsistent identity or organizations', async () => {
  const { createStrataClient } = await import('@/process/services/jr/strataClient');
  const status = {
    configured: true,
    linked: true,
    erpUser: { id: 'erp-fixture', name: 'Test account' },
    organizations: [{ id: 'organization-fixture', name: 'Test company' }],
    organizationId: 'organization-fixture',
    linkedAt: '2026-11-06T12:00:00Z',
  };
  const client = createStrataClient(async () => ({ ...status, accessToken: 'fixture-token-never-return' }));
  expect(await client.status()).toEqual(status);
  await expect(
    createStrataClient(async () => ({ ...status, organizationId: 'another-organization' })).status()
  ).rejects.toThrow('JR_STRATA_INVALID_RESPONSE');
  await expect(createStrataClient(async () => ({ ...status, erpUser: null })).status()).rejects.toThrow(
    'JR_STRATA_INVALID_RESPONSE'
  );
});

it('Strata client accepts only HTTPS browser authorization and never forwards a model-supplied URL', async () => {
  const { createStrataClient } = await import('@/process/services/jr/strataClient');
  for (const authorizationUrl of [
    'javascript:alert(1)',
    'file:///private/file',
    'https://person:secret@example.test/oauth',
  ]) {
    await expect(
      createStrataClient(async () => ({ authorizationUrl, expiresAt: '2026-11-06T12:00:00Z' })).connect()
    ).rejects.toThrow('JR_STRATA_INVALID_RESPONSE');
  }
});

it('Strata tool calls preserve MCP errors while returning no transport secrets', async () => {
  const { createStrataClient } = await import('@/process/services/jr/strataClient');
  const call = vi.fn(async (_path: string, _init?: RequestInit) => ({
    content: [{ type: 'text', text: 'permission_denied' }],
    isError: true,
    headers: { authorization: 'private-fixture' },
  }));
  const client = createStrataClient(call);
  expect(await client.callTool({ name: 'compras.consultar', arguments: {} })).toEqual({
    content: [{ type: 'text', text: 'permission_denied' }],
    isError: true,
  });
  expect(call.mock.calls[0][0]).toBe('/strata/mcp/call');
  await expect(client.callTool({ name: '../../admin', arguments: {} })).rejects.toThrow('JR_STRATA_INVALID_REQUEST');
});

it('Strata tool discovery rejects malformed schemas rather than giving the model a fake success', async () => {
  const { createStrataClient } = await import('@/process/services/jr/strataClient');
  await expect(
    createStrataClient(async () => ({ tools: [{ name: 'erp.quem_sou', inputSchema: null }] })).tools()
  ).rejects.toThrow('JR_STRATA_INVALID_RESPONSE');
});

it('Strata native login opens the backend URL and returns only expiry to the renderer', async () => {
  vi.resetModules();
  const providers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const openExternal = vi.fn(async () => {});
  const expiresAt = '2026-11-06T12:00:00Z';
  const authorizationUrl = 'https://issuer.example/oauth/authorize?state=fixture';
  const strataCall = vi.fn(async () => ({ authorizationUrl, expiresAt, accessToken: 'private-fixture' }));
  vi.doMock('electron', () => ({ shell: { openExternal } }));
  vi.doMock('@/common', () => ({
    ipcBridge: {
      jr: {
        strata: {
          ...Object.fromEntries(
            ['status', 'connect', 'organization', 'disconnect'].map((name) => [
              name,
              {
                provider: (handler: (...args: unknown[]) => Promise<unknown>) => {
                  providers[name] = handler;
                },
              },
            ])
          ),
          changed: { emit: vi.fn() },
        },
      },
    },
  }));
  vi.doMock('@/process/services/jr/auth', () => ({
    getJrAccessController: () => ({ state: { status: 'authenticated', user: { id: 'jr-fixture' } }, strataCall }),
  }));
  try {
    const { initStrataBridge } = await import('@/process/services/jr/strataIpc');
    initStrataBridge();
    expect(await providers.connect()).toEqual({ expiresAt });
    expect(openExternal).toHaveBeenCalledWith(authorizationUrl);
    expect(strataCall).toHaveBeenCalledWith('/strata/connect', expect.objectContaining({ method: 'POST' }));
  } finally {
    vi.doUnmock('electron');
    vi.doUnmock('@/common');
    vi.doUnmock('@/process/services/jr/auth');
  }
});

it('Strata native execution observes only successful known ERP query receipts after the call completes', async () => {
  vi.resetModules();
  const order: string[] = [];
  const completed = vi.fn(async () => {
    order.push('completed');
  });
  const beginWorkEvent = vi.fn(() => {
    order.push('began');
    return completed;
  });
  let result: Record<string, unknown> = {
    content: [{ type: 'text', text: JSON.stringify({ items: [], page: { limit: 20, offset: 0, total: 0 } }) }],
  };
  const strataCall = vi.fn(async () => {
    order.push('requested');
    return result;
  });
  vi.doMock('electron', () => ({ shell: { openExternal: vi.fn() } }));
  vi.doMock('@/common', () => ({ ipcBridge: {} }));
  vi.doMock('@/process/services/jr/auth', () => ({ getJrAccessController: () => ({ strataCall }) }));
  vi.doMock('@/process/services/teach/registry', () => ({ getLearnService: () => ({ beginWorkEvent }) }));
  try {
    const { getStrataClient } = await import('@/process/services/jr/strataIpc');
    const client = getStrataClient();
    await client.callTool({ name: 'obras.listar', arguments: { query: 'private query never forwarded to learning' } });
    expect(order).toEqual(['began', 'requested', 'completed']);
    expect(completed).toHaveBeenCalledWith();
    completed.mockClear();
    for (const receipt of [
      {
        content: [{ type: 'text', text: JSON.stringify({ items: [], page: { limit: 20, offset: 0, total: 0 } }) }],
        isError: true,
      },
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ status: 'aguardando_consentimento', consent_url: 'https://erp.test/approve' }),
          },
        ],
      },
      { content: [{ type: 'text', text: 'The model says the query finished' }] },
    ]) {
      result = receipt;
      await client.callTool({ name: 'obras.listar', arguments: {} });
    }
    expect(completed).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock('electron');
    vi.doUnmock('@/common');
    vi.doUnmock('@/process/services/jr/auth');
    vi.doUnmock('@/process/services/teach/registry');
  }
});

it('creates the canonical employee assistant once during concurrent requests and never reassigns legacy assistants', async () => {
  const { createEmployeeAssistantRegistry } = await import('@/process/services/jr/bootstrap');
  const rows = [
    { id: 'runtime', source: 'generated', agent_id: 'embedded', agent: { type: 'aionrs' } },
  ] as unknown as import('@/common/types/agent/assistantTypes').Assistant[];
  const create = vi.fn(async (input: import('@/common/types/agent/assistantTypes').CreateAssistantRequest) => {
    const assistant = { ...rows[0], ...input, source: 'user' as const };
    rows.push(assistant);
    return assistant;
  });
  const identity = { ownerAccountId: 'account-a', assistantId: 'employee-a', generation: 1 };
  const register = createEmployeeAssistantRegistry({
    identity: () => identity,
    list: async () => rows,
    create,
    skills: async () => ['read', 'read'],
  });
  expect(await Promise.all([register({ name: 'A' }), register({ name: 'A' })])).toEqual(
    [identity, identity].map(({ generation: _generation, ...result }) => result)
  );
  await register({ name: 'Renamed' });
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'employee-a',
      avatar: '🤖',
      defaults: { skills: { mode: 'fixed', value: ['read'] } },
    })
  );
});

it('keeps canonical assistant identities separate for different authenticated accounts', async () => {
  const { createEmployeeAssistantRegistry } = await import('@/process/services/jr/bootstrap');
  const runtime = {
    id: 'runtime',
    source: 'generated',
    agent_id: 'embedded',
    agent: { type: 'aionrs' },
  } as unknown as import('@/common/types/agent/assistantTypes').Assistant;
  let identity = { ownerAccountId: 'account-a', assistantId: 'employee-a', generation: 1 };
  const create = vi.fn(async (input: import('@/common/types/agent/assistantTypes').CreateAssistantRequest) => ({
    ...runtime,
    ...input,
  }));
  const register = createEmployeeAssistantRegistry({
    identity: () => identity,
    list: async () => [runtime],
    create,
    skills: async () => [],
  });
  await register({ name: 'Same name' });
  identity = { ownerAccountId: 'account-b', assistantId: 'employee-b', generation: 2 };
  await register({ name: 'Same name' });
  expect(create.mock.calls.map(([input]) => input.id)).toEqual(['employee-a', 'employee-b']);
});

it('rejects assistant creation if logout or relogin changes the session while the catalog loads', async () => {
  const { createEmployeeAssistantRegistry } = await import('@/process/services/jr/bootstrap');
  let generation = 1;
  const create = vi.fn();
  const register = createEmployeeAssistantRegistry({
    identity: () => ({ ownerAccountId: 'account-a', assistantId: 'employee-a', generation }),
    list: async () => {
      generation += 1;
      return [];
    },
    create,
    skills: async () => [],
  });
  await expect(register({ name: 'A' })).rejects.toThrow('JR_ACCESS_REQUIRED');
  expect(create).not.toHaveBeenCalled();
});

it('refuses to take over an existing non-user assistant at the canonical id', async () => {
  const { createEmployeeAssistantRegistry } = await import('@/process/services/jr/bootstrap');
  const create = vi.fn();
  const register = createEmployeeAssistantRegistry({
    identity: () => ({ ownerAccountId: 'account-a', assistantId: 'employee-a', generation: 1 }),
    list: async () =>
      [
        { id: 'employee-a', source: 'builtin', agent: { type: 'aionrs' } },
      ] as unknown as import('@/common/types/agent/assistantTypes').Assistant[],
    create,
    skills: async () => [],
  });
  await expect(register({ name: 'A' })).rejects.toThrow('JR_ASSISTANT_ID_CONFLICT');
  expect(create).not.toHaveBeenCalled();
});
