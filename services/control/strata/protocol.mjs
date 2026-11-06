import { randomUUID } from 'node:crypto';
import { httpError } from '../validation.mjs';
import { issuerEndpoint } from './config.mjs';

const LIMIT = 1024 * 1024;
export const MCP_PROTOCOL = '2025-11-25';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function boundedText(response) {
  if (Number(response.headers.get('content-length') ?? 0) > LIMIT) {
    await response.body?.cancel();
    throw httpError(503, 'strata_invalid_response');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      // Stream reads are ordered; concurrent reads would defeat the size bound.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) throw httpError(503, 'strata_invalid_response');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function request(config, fetcher, url, init = {}) {
  try {
    const response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const text = await boundedText(response);
    if (!response.ok)
      throw httpError(
        [401, 403].includes(response.status) ? 403 : 503,
        response.status === 401
          ? 'strata_reconnect_required'
          : response.status === 403
            ? 'strata_forbidden'
            : 'strata_unavailable'
      );
    return { response, text };
  } catch (error) {
    if (error?.code?.startsWith('strata_')) throw error;
    throw httpError(503, 'strata_unavailable');
  }
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(503, 'strata_invalid_response');
  }
}

export async function discover(config, fetcher) {
  const needsOfflineAccess = config.scopes.includes('offline_access');
  const resource = new URL(config.resourceUrl);
  const resourceMetadataUrl = new URL(`/.well-known/oauth-protected-resource${resource.pathname}`, resource.origin);
  const metadata = parseJson((await request(config, fetcher, resourceMetadataUrl)).text);
  if (
    !record(metadata) ||
    metadata.resource !== config.resourceUrl ||
    !Array.isArray(metadata.authorization_servers) ||
    !metadata.authorization_servers.includes(config.issuer) ||
    !Array.isArray(metadata.scopes_supported) ||
    config.scopes.some((scope) => scope !== 'offline_access' && !metadata.scopes_supported.includes(scope))
  )
    throw httpError(503, 'strata_invalid_metadata');
  const issuer = new URL(config.issuer);
  const path = issuer.pathname.replace(/\/$/u, '');
  const candidates = path
    ? [
        `/.well-known/oauth-authorization-server${path}`,
        `/.well-known/openid-configuration${path}`,
        `${path}/.well-known/openid-configuration`,
      ]
    : ['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server'];
  for (const candidatePath of candidates) {
    let body;
    try {
      // Metadata locations are fallback alternatives: stop after the first valid document.
      // eslint-disable-next-line no-await-in-loop
      body = parseJson((await request(config, fetcher, new URL(candidatePath, issuer.origin))).text);
    } catch {
      continue;
    }
    if (
      !record(body) ||
      String(body.issuer).replace(/\/$/u, '') !== config.issuer ||
      !body.code_challenge_methods_supported?.includes('S256') ||
      !body.response_types_supported?.includes('code') ||
      !body.token_endpoint_auth_methods_supported?.includes('client_secret_basic') ||
      (needsOfflineAccess &&
        (!Array.isArray(body.scopes_supported) || !body.scopes_supported.includes('offline_access')))
    )
      continue;
    return {
      authorizationEndpoint: issuerEndpoint(config, body.authorization_endpoint),
      tokenEndpoint: issuerEndpoint(config, body.token_endpoint),
    };
  }
  throw httpError(503, 'strata_invalid_metadata');
}

/** One standard initialization per operation; ERP revalidates identity and permissions on every RPC. */
export async function mcpClient(config, fetcher, accessToken, erpUserId) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'X-Erp-User-Id': erpUserId,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL,
  };
  const rpc = async (method, params, notification = false) => {
    const id = randomUUID();
    const { text, response } = await request(config, fetcher, config.resourceUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(notification ? {} : { id }),
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    if (notification && (!text || response.status === 202 || response.status === 204)) return null;
    const messages = response.headers.get('content-type')?.includes('text/event-stream')
      ? text
          .split(/\r?\n\r?\n/u)
          .map((event) =>
            event
              .split(/\r?\n/u)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n')
          )
          .filter(Boolean)
          .map(parseJson)
      : [parseJson(text)];
    const message = messages.find((item) => record(item) && item.id === id);
    if (!message || message.jsonrpc !== '2.0' || message.error || !record(message.result))
      throw httpError(503, 'strata_invalid_response');
    return message.result;
  };
  const initialized = await rpc('initialize', {
    protocolVersion: MCP_PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'jr-bot-control', version: '1.0' },
  });
  if (initialized.protocolVersion !== MCP_PROTOCOL) throw httpError(503, 'strata_invalid_response');
  await rpc('notifications/initialized', undefined, true);
  return { rpc };
}

export function toolJson(result) {
  if (!record(result) || result.isError === true) throw httpError(403, 'strata_forbidden');
  const value =
    result.structuredContent ??
    result.content
      ?.filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
  return typeof value === 'string' ? parseJson(value) : value;
}
