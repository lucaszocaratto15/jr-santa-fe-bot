import { randomUUID } from 'node:crypto';
import { createSseReader, httpError, isHttpError, parseUsage } from './validation.mjs';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Proxy one configured model and cancel every active request belonging to a revoked identity. */
export function createModelProxy({ store, upstreamUrl, upstreamKey, model, upstreamFetch = fetch, now = Date.now }) {
  const active = new Map();
  const abortWhere = (matches) => {
    for (const entry of active.values()) {
      if (matches(entry)) entry.controller.abort(httpError(401, 'invalid_session'));
    }
  };
  return {
    async handle(request, response, session, loadBody) {
      if (active.size >= 16 || [...active.values()].filter((entry) => entry.userId === session.user.id).length >= 4)
        throw httpError(429, 'too_many_requests');
      const id = randomUUID();
      const controller = new AbortController();
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      active.set(id, { userId: session.user.id, sessionHash: session.sessionHash, controller, done });
      let startedAt = now();
      let requestId = null;
      let firstByteMs = null;
      let usage = null;
      let upstreamStatus = null;
      let status = 'failed';
      let reader;
      const timeout = setTimeout(() => controller.abort(httpError(504, 'upstream_timeout')), 180_000);
      timeout.unref();
      const abortOnDisconnect = () => {
        if (!response.writableEnded) controller.abort(httpError(499, 'request_cancelled'));
      };
      const cancelReader = () => {
        void reader?.cancel().catch(() => {});
      };
      request.once('aborted', abortOnDisconnect);
      response.once('close', abortOnDisconnect);
      controller.signal.addEventListener('abort', cancelReader, { once: true });
      try {
        const body = await loadBody();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (
          !body ||
          typeof body !== 'object' ||
          !Array.isArray(body.messages) ||
          body.messages.length === 0 ||
          body.messages.length > 1000 ||
          (body.model !== undefined && body.model !== model) ||
          (body.stream !== undefined && typeof body.stream !== 'boolean') ||
          (body.stream_options !== undefined &&
            (!body.stream_options || typeof body.stream_options !== 'object' || Array.isArray(body.stream_options)))
        ) {
          throw httpError(400, 'invalid_request');
        }
        const policy =
          'Responda sempre em português do Brasil, inclusive nas mensagens de andamento. Seja claro e breve. Não apresente raciocínio interno. Preserve literalmente arquivos, comandos, parâmetros, endereços e resultados das ferramentas. Mantenha todas as regras de confirmação e segurança anteriores.';
        const system = body.messages.find(
          (message) => message?.role === 'system' && typeof message.content === 'string'
        );
        if (system) system.content += '\n\n' + policy;
        else body.messages.unshift({ role: 'system', content: policy });
        requestId = store.beginRequest(session.user.id);
        startedAt = now();
        const payload = {
          ...body,
          model,
          ...(body.stream ? { stream_options: { ...body.stream_options, include_usage: true } } : {}),
        };
        const upstream = await upstreamFetch(`${upstreamUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${upstreamKey}`,
            'Content-Type': 'application/json',
            Accept: body.stream ? 'text/event-stream' : 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
          redirect: 'error',
        });
        if (controller.signal.aborted) throw controller.signal.reason;
        upstreamStatus = upstream.status;
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel();
          throw httpError(502, 'upstream_unavailable');
        }
        reader = upstream.body.getReader();
        const stream = body.stream === true;
        if (stream && !upstream.headers.get('content-type')?.includes('text/event-stream'))
          throw httpError(502, 'upstream_unavailable');
        const sseReader = createSseReader(upstreamKey);
        const chunks = [];
        let received = 0;
        if (stream) {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
          });
        }
        const forwardSse = async (chunk, final = false) => {
          const parsed = sseReader.push(chunk, final);
          usage = parsed.usage;
          for (const frame of parsed.frames) {
            if (!response.write(frame)) {
              await new Promise((resolve, reject) => {
                const cleanup = () => {
                  response.off('drain', drained);
                  controller.signal.removeEventListener('abort', aborted);
                };
                const drained = () => {
                  cleanup();
                  resolve();
                };
                const aborted = () => {
                  cleanup();
                  reject(controller.signal.reason);
                };
                response.once('drain', drained);
                controller.signal.addEventListener('abort', aborted, { once: true });
                if (controller.signal.aborted) aborted();
              });
            }
          }
        };
        while (true) {
          const next = await reader.read();
          if (controller.signal.aborted) throw controller.signal.reason;
          if (next.done) break;
          if (firstByteMs === null) firstByteMs = Math.max(0, now() - startedAt);
          if (stream) {
            await forwardSse(next.value);
          } else {
            received += next.value.byteLength;
            if (received > MAX_RESPONSE_BYTES) throw httpError(502, 'upstream_unavailable');
            chunks.push(next.value);
          }
        }
        if (stream) await forwardSse(undefined, true);
        else {
          const text = Buffer.concat(chunks).toString('utf8');
          const data = JSON.parse(text);
          if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || text.includes(upstreamKey))
            throw httpError(502, 'upstream_unavailable');
          usage = parseUsage(data.usage);
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          response.write(text);
        }
        status = 'completed';
        response.end();
      } catch (error) {
        status = controller.signal.aborted ? 'cancelled' : 'failed';
        const abortReason = controller.signal.aborted ? controller.signal.reason : null;
        if (!controller.signal.aborted) controller.abort();
        const publicError = isHttpError(abortReason)
          ? abortReason
          : isHttpError(error)
            ? error
            : httpError(502, 'upstream_unavailable');
        if (response.headersSent || response.destroyed) response.destroy();
        else {
          response.writeHead(publicError.status ?? 502, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end(JSON.stringify({ error: { code: publicError.code ?? 'upstream_unavailable' } }));
        }
      } finally {
        clearTimeout(timeout);
        request.off('aborted', abortOnDisconnect);
        response.off('close', abortOnDisconnect);
        controller.signal.removeEventListener('abort', cancelReader);
        await reader?.cancel().catch(() => {});
        try {
          if (requestId) store.finishRequest(requestId, { status, usage, firstByteMs, upstreamStatus });
        } finally {
          active.delete(id);
          resolveDone();
        }
      }
    },
    revokeUser(userId) {
      abortWhere((entry) => entry.userId === userId);
    },
    revokeSession(sessionHash) {
      abortWhere((entry) => entry.sessionHash === sessionHash);
    },
    async close() {
      abortWhere(() => true);
      await Promise.allSettled([...active.values()].map((entry) => entry.done));
    },
  };
}
