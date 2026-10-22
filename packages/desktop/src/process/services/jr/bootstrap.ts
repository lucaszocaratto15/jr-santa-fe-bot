import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

type RelayEnvironment = Record<string, string | undefined>;
export type JrRelayConfig = { url: string; token: string; model: string };

export async function createJrWorkspace(userDataPath: string): Promise<string> {
  if (!isAbsolute(userDataPath)) throw new Error('Invalid local workspace root');
  const directory = join(userDataPath, 'jr-workspaces', randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
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
  const list = (await listed.json()) as { data?: Array<{ id: string; name: string }> };
  const existing = list.data?.find((provider) => provider.name === 'JR MiniMax');
  const body = {
    name: 'JR MiniMax',
    platform: 'openai',
    base_url: config.url,
    api_key: config.token,
    models: [config.model],
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
  const result = (await response.json()) as { success?: boolean };
  if (!result.success) throw new Error('Company connection was not accepted');
}
