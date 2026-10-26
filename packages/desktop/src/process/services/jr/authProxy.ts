import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { JrProxyDenial } from './auth';
import type { JrRelayConfig } from './bootstrap';

type JrAuthProxy = { connection: JrRelayConfig; close: () => Promise<void> };

/** Provider rejections the agent must see as-is: 413 and context-length 400 trigger its compaction retry. */
const PASSTHROUGH_STATUS = new Set([400, 413]);
const ERROR_BODY_LIMIT = 64 * 1024;
// ponytail: control can take compaction (60s) plus its header deadline (180s) before answering.
const HEADERS_TIMEOUT_MS = 300_000;

/** Null when the body is larger than the limit. */
async function readErrorBody(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > ERROR_BODY_LIMIT) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= ERROR_BODY_LIMIT) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > ERROR_BODY_LIMIT) return null;
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

function denialCode(text: string | null): string | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || !('error' in value)) return null;
    const error = (value as { error?: { code?: unknown } }).error;
    return error && typeof error.code === 'string' ? error.code : null;
  } catch {
    return null;
  }
}

/** Exchange a renderer-visible local capability for the native-only remote session. */
export async function startJrAuthProxy(
  remote: JrRelayConfig,
  onDenied: (notice: JrProxyDenial) => void,
  request: typeof fetch = fetch
): Promise<JrAuthProxy> {
  const capability = randomBytes(32).toString('hex');
  const active = new Set<AbortController>();
  const server = createServer(async (incoming, outgoing) => {
    const received = Buffer.from(incoming.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${capability}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      outgoing.writeHead(401).end();
      return;
    }
    const route = incoming.url;
    if (
      !(
        (incoming.method === 'GET' && route === '/v1/models') ||
        (incoming.method === 'POST' && route === '/v1/chat/completions')
      )
    ) {
      outgoing.writeHead(404).end();
      return;
    }
    const abort = new AbortController();
    active.add(abort);
    outgoing.on('close', () => {
      if (!outgoing.writableFinished) abort.abort();
    });
    try {
      let body: string | undefined;
      if (incoming.method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of incoming) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > 16 * 1024 * 1024) {
            outgoing.writeHead(413).end();
            return;
          }
          chunks.push(bytes);
        }
        body = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          outgoing.writeHead(400).end();
          return;
        }
        if (!parsed || typeof parsed !== 'object' || !('model' in parsed) || parsed.model !== remote.model) {
          outgoing.writeHead(400).end();
          return;
        }
      }
      // The deadline covers only the wait for headers. A stream that already started is never cut.
      const headersDeadline = setTimeout(() => abort.abort(), HEADERS_TIMEOUT_MS);
      let response: Response;
      try {
        response = await request(`${remote.url}${route.slice(3)}`, {
          method: incoming.method,
          headers: { Authorization: `Bearer ${remote.token}`, 'Content-Type': 'application/json' },
          body,
          redirect: 'error',
          signal: abort.signal,
        });
      } finally {
        clearTimeout(headersDeadline);
      }
      if (abort.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok) {
        const text = await readErrorBody(response);
        const code = denialCode(text);
        const restriction = response.status === 403 && (code === 'employee_blocked' || code === 'outside_access_hours');
        const revoked = response.status === 401;
        if (revoked || restriction) {
          outgoing.writeHead(response.status).end();
          onDenied({ status: response.status, code });
          return;
        }
        if (PASSTHROUGH_STATUS.has(response.status) && text !== null) {
          outgoing
            .writeHead(response.status, {
              'Content-Type': response.headers.get('Content-Type')?.includes('json')
                ? 'application/json'
                : 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            .end(text.split(remote.token).join('[redacted]'));
          return;
        }
        outgoing.writeHead(502).end();
        return;
      }
      const provider = response.headers.get('x-jr-provider');
      outgoing.writeHead(response.status, {
        'Content-Type': response.headers.get('Content-Type')?.startsWith('text/event-stream')
          ? 'text/event-stream'
          : 'application/json',
        'Cache-Control': 'no-store',
        ...(provider === 'minimax' || provider === 'openrouter' || provider === 'gemini'
          ? { 'X-JR-Provider': provider }
          : {}),
      });
      if (response.body)
        await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), outgoing);
      else outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    } finally {
      active.delete(abort);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('JR_ACCESS_PROXY_UNAVAILABLE');
  }
  let closed = false;
  return {
    connection: { url: `http://127.0.0.1:${address.port}/v1`, token: capability, model: remote.model },
    async close() {
      if (closed) return;
      closed = true;
      for (const abort of active) abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
