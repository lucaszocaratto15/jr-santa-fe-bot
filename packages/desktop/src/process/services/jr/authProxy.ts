import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { JrRelayConfig } from './bootstrap';

type JrAuthProxy = { connection: JrRelayConfig; close: () => Promise<void> };

/** Exchange a renderer-visible local capability for the native-only remote session. */
export async function startJrAuthProxy(
  remote: JrRelayConfig,
  onUnauthorized: () => void,
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
      const response = await request(`${remote.url}${route.slice(3)}`, {
        method: incoming.method,
        headers: { Authorization: `Bearer ${remote.token}`, 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
      });
      if (abort.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok) {
        await response.body?.cancel();
        outgoing.writeHead(response.status === 401 ? 401 : 502).end();
        if (response.status === 401) onUnauthorized();
        return;
      }
      outgoing.writeHead(response.status, {
        'Content-Type': response.headers.get('Content-Type')?.startsWith('text/event-stream')
          ? 'text/event-stream'
          : 'application/json',
        'Cache-Control': 'no-store',
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
