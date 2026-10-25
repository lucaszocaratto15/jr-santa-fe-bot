import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

type RelayEnvironment = Record<string, string | undefined>;
export type JrRelayConfig = { url: string; token: string; model: string };

const JR_AIONRS_CONFIG = `# Gerenciado pelo JR Bot: compacte o contexto antes do limite do provedor.
[compact]
enabled = true
context_window = 200000
autocompact_threshold_pct = 55
`;

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

/** Add JR compaction defaults without overwriting a workspace-owned AionRS config. */
export async function configureJrWorkspaceContext(userDataPath: string, workspace: string): Promise<void> {
  if (!isAbsolute(userDataPath) || !isAbsolute(workspace)) throw new Error('Invalid local workspace root');
  const userData = await realpath(userDataPath);
  const workspaceRoot = join(resolve(userDataPath), 'jr-workspaces');
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(workspaceRoot);
  if (dirname(realRoot) !== userData) throw new Error('Invalid local workspace root');
  const candidate = resolve(workspace);
  if (!isWithin(workspaceRoot, candidate)) throw new Error('Invalid local workspace path');
  const realWorkspace = await realpath(candidate);
  if (!isWithin(realRoot, realWorkspace) || dirname(realWorkspace) !== realRoot)
    throw new Error('Invalid local workspace path');

  const configPath = join(realWorkspace, '.aionrs.toml');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(configPath, 'wx', 0o600);
    await file.writeFile(JR_AIONRS_CONFIG, 'utf8');
    await file.close();
  } catch (error) {
    await file?.close().catch((): void => undefined);
    if (file) await unlink(configPath).catch((): void => undefined);
    if (hasErrorCode(error, 'EEXIST')) return;
    throw error;
  }
}

export async function createJrWorkspace(userDataPath: string): Promise<string> {
  if (!isAbsolute(userDataPath)) throw new Error('Invalid local workspace root');
  const directory = join(userDataPath, 'jr-workspaces', randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await configureJrWorkspaceContext(userDataPath, directory);
  return directory;
}

export function getJrRelayConfig(env: RelayEnvironment = process.env): JrRelayConfig | null {
  if (env.JR_LOCAL_PILOT !== '1') return null;
  if (!env.JR_RELAY_URL && !env.JR_RELAY_TOKEN) return null;
  return validateLocalConnection({
    url: env.JR_RELAY_URL || '',
    token: env.JR_RELAY_TOKEN || '',
    model: env.JR_MINIMAX_MODEL || '',
  });
}

function providerRows(value: unknown): Array<{ id: string; name: string }> {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : [];
  return rows.filter(
    (row): row is { id: string; name: string } =>
      Boolean(row) &&
      typeof row === 'object' &&
      typeof (row as { id?: unknown }).id === 'string' &&
      typeof (row as { name?: unknown }).name === 'string'
  );
}

export type LoopbackProvider = {
  id: string;
  name: string;
  platform: string;
  base_url: string;
  api_key: '';
  enabled?: boolean;
  models: string[];
};

function modelIdsFrom(value: unknown): string[] {
  let rows: unknown[] = [];
  if (Array.isArray(value)) rows = value;
  else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        rows = Array.isArray(parsed) ? parsed : [trimmed];
      } catch {
        rows = [trimmed];
      }
    } else if (trimmed) rows = [trimmed];
  }
  return rows
    .map((model) => {
      if (typeof model === 'string') return model;
      if (model && typeof model === 'object' && 'id' in model && typeof model.id === 'string') return model.id;
      return '';
    })
    .filter((id) => id.length > 0);
}

/** Read the local catalog the same way the gateway writer does, without a renderer session. */
export function providersFromList(value: unknown): LoopbackProvider[] {
  const record = value && typeof value === 'object' ? (value as { data?: unknown }) : null;
  const rows = Array.isArray(value) ? value : Array.isArray(record?.data) ? record.data : [];
  const result: LoopbackProvider[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as {
      id?: unknown;
      name?: unknown;
      platform?: unknown;
      base_url?: unknown;
      enabled?: unknown;
      models?: unknown;
    };
    if (typeof item.id !== 'string' || typeof item.name !== 'string') continue;
    const enabled =
      item.enabled === true || item.enabled === 1
        ? true
        : item.enabled === false || item.enabled === 0
          ? false
          : undefined;
    result.push({
      id: item.id,
      name: item.name,
      platform: typeof item.platform === 'string' ? item.platform : '',
      base_url: typeof item.base_url === 'string' ? item.base_url : '',
      api_key: '',
      ...(enabled === undefined ? {} : { enabled }),
      models: modelIdsFrom(item.models),
    });
  }
  return result;
}

export async function readLoopbackProviders(port: number, request: typeof fetch = fetch): Promise<LoopbackProvider[]> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return [];
  const response = await request(`http://127.0.0.1:${port}/api/providers`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Provider list failed (${response.status})`);
  return providersFromList(await response.json());
}

function providerAccepted(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const body = value as { success?: unknown; id?: unknown; data?: { id?: unknown } };
  return body.success === true || typeof body.id === 'string' || typeof body.data?.id === 'string';
}

function validateLocalConnection(config: JrRelayConfig): JrRelayConfig {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error('Invalid local company connection');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/v1' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !/^[a-f0-9]{64}$/.test(config.token) ||
    !/^MiniMax-[A-Za-z0-9.-]+$/.test(config.model)
  ) {
    throw new Error('Invalid local company connection');
  }
  return { url: url.toString().replace(/\/$/, ''), token: config.token, model: config.model };
}

/** Development connection: only the relay's temporary token reaches the local core. */
export async function bootstrapJrConnection(
  port: number,
  env: RelayEnvironment = process.env,
  request: typeof fetch = fetch
): Promise<void> {
  const config = getJrRelayConfig(env);
  if (!config) return;
  await configureJrProvider(port, config, request);
}

/** Configure the local core with a revocable local proxy capability. */
export async function configureJrProvider(
  port: number,
  config: JrRelayConfig,
  request: typeof fetch = fetch
): Promise<void> {
  config = validateLocalConnection(config);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid local backend port');
  const base = `http://127.0.0.1:${port}/api/providers`;
  const options = { redirect: 'error' as const, signal: AbortSignal.timeout(10000) };
  const listed = await request(base, options);
  if (!listed.ok) throw new Error('Company connection could not be configured');
  const existing = providerRows(await listed.json()).find((provider) => provider.name === 'JR MiniMax');
  const body = {
    name: 'JR MiniMax',
    platform: 'openai',
    base_url: config.url,
    api_key: config.token,
    models: [config.model],
    enabled: true,
    capabilities: [{ type: 'text' }, { type: 'function_calling' }],
    context_limit: 65536,
    model_settings: { [config.model]: { openai_api_mode: 'chat_completions' } },
  };
  const response = await request(existing ? `${base}/${encodeURIComponent(existing.id)}` : base, {
    ...options,
    signal: AbortSignal.timeout(10000),
    method: existing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Company connection could not be configured');
  if (!providerAccepted(await response.json())) throw new Error('Company connection was not accepted');
}
