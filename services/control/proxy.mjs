import { randomUUID } from 'node:crypto';
import { createSseReader, httpError, isHttpError, parseUsage } from './validation.mjs';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const PRIMARY_FAILURES = 3;
const CIRCUIT_OPEN_MS = 3 * 60 * 1000;
const ATTEMPT_MS = 45_000;

function canFailOver(status) {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

function markFailover(error) {
  error.failover = true;
  return error;
}

/** Proxy one configured model and cancel every active request belonging to a revoked identity. */
export function createModelProxy({
  store,
  upstreamUrl,
  upstreamKey,
  model,
  fallback = { enabled: false, providers: [], secrets: [] },
  upstreamFetch = fetch,
  now = Date.now,
  log = (line) => process.stdout.write(`${line}\n`),
  fallbackAttemptMs = ATTEMPT_MS,
}) {
  const backups = Array.isArray(fallback.providers) ? fallback.providers : [];
  const secretValues = [upstreamKey, ...(Array.isArray(fallback.secrets) ? fallback.secrets : [])].filter(
    (secret) => typeof secret === 'string' && secret.length > 0
  );
  const circuit = { failures: 0, openUntil: 0 };
  let awayFromPrimary = false;
  const safeLog = (line) => {
    try {
      if (typeof line !== 'string' || secretValues.some((secret) => line.includes(secret))) return;
      log(line);
    } catch {
      // A logging failure must not change the model response.
    }
  };
  const circuitOpen = (timestamp) => circuit.failures >= PRIMARY_FAILURES && timestamp < circuit.openUntil;
  const notePrimaryFailure = (timestamp) => {
    if (backups.length === 0) return;
    circuit.failures += 1;
    if (circuit.failures < PRIMARY_FAILURES) return;
    const alreadyOpen = circuit.openUntil > timestamp;
    circuit.openUntil = timestamp + CIRCUIT_OPEN_MS;
    if (!alreadyOpen && circuit.failures === PRIMARY_FAILURES) safeLog('Provedor: circuito aberto');
  };
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
        const tokenPolicy = store.tokenPolicy(session.user.id);
        if (tokenPolicy) {
          if ([...active.values()].filter((entry) => entry.userId === session.user.id).length > 1)
            throw httpError(429, 'token_limit_request_in_progress');
          if (tokenPolicy.unmeteredRequests > 0) throw httpError(429, 'token_usage_unavailable');
          if (tokenPolicy.remaining <= 0) throw httpError(429, 'token_limit_reached');
          const requestedMax = body.max_completion_tokens ?? body.max_tokens;
          const outputLimit =
            Number.isSafeInteger(requestedMax) && requestedMax >= 0
              ? Math.min(tokenPolicy.remaining, requestedMax)
              : tokenPolicy.remaining;
          body.max_tokens = outputLimit;
          if (body.max_completion_tokens !== undefined) body.max_completion_tokens = outputLimit;
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
        const stream = body.stream === true;
        const payload = {
          ...body,
          model,
          ...(stream ? { stream_options: { ...body.stream_options, include_usage: true } } : {}),
        };
        const primary = { id: 'minimax', model, url: `${upstreamUrl}/chat/completions`, key: upstreamKey };
        const providers = backups.length === 0 || !circuitOpen(now()) ? [primary, ...backups] : backups;
        const fetchProvider = async (provider) => {
          const linked = backups.length > 0;
          const attempt = linked ? new AbortController() : null;
          const abortAttempt = () => attempt.abort(controller.signal.reason);
          if (linked) {
            if (controller.signal.aborted) throw controller.signal.reason;
            controller.signal.addEventListener('abort', abortAttempt, { once: true });
          }
          let timedOut = false;
          const timer = linked
            ? setTimeout(() => {
                timedOut = true;
                attempt.abort(httpError(504, 'upstream_timeout'));
              }, fallbackAttemptMs)
            : null;
          timer?.unref();
          try {
            const upstream = await upstreamFetch(provider.url, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${provider.key}`,
                'Content-Type': 'application/json',
                Accept: stream ? 'text/event-stream' : 'application/json',
              },
              body: JSON.stringify({ ...payload, model: provider.model }),
              signal: attempt ? attempt.signal : controller.signal,
              redirect: 'error',
            });
            if (controller.signal.aborted) throw controller.signal.reason;
            if (timedOut) {
              await upstream.body?.cancel().catch(() => {});
              return { failover: true, failure: true, status: 504, error: httpError(504, 'upstream_timeout') };
            }
            const failover = canFailOver(upstream.status);
            if (!upstream.ok || !upstream.body) {
              await upstream.body?.cancel().catch(() => {});
              return {
                failover,
                failure: failover,
                status: upstream.status,
                error: httpError(502, 'upstream_unavailable'),
              };
            }
            return { response: upstream, status: upstream.status };
          } catch (error) {
            if (controller.signal.aborted) return { aborted: true, reason: controller.signal.reason };
            if (isHttpError(error) && !timedOut) throw error;
            return {
              failover: true,
              failure: true,
              status: timedOut ? 504 : null,
              error: httpError(timedOut ? 504 : 502, timedOut ? 'upstream_timeout' : 'upstream_unavailable'),
            };
          } finally {
            if (timer) clearTimeout(timer);
            if (linked) controller.signal.removeEventListener('abort', abortAttempt);
          }
        };
        const readJsonBody = async (upstream) => {
          const local = upstream.body.getReader();
          const chunks = [];
          let received = 0;
          try {
            while (true) {
              const next = await local.read();
              if (controller.signal.aborted) throw controller.signal.reason;
              if (next.done) break;
              received += next.value.byteLength;
              if (received > MAX_RESPONSE_BYTES) throw markFailover(httpError(502, 'upstream_unavailable'));
              chunks.push(next.value);
            }
          } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            if (error?.failover) throw error;
            throw markFailover(httpError(502, 'upstream_unavailable'));
          } finally {
            await local.cancel().catch(() => {});
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            throw markFailover(httpError(502, 'upstream_unavailable'));
          }
          if (
            !data ||
            typeof data !== 'object' ||
            Array.isArray(data) ||
            data.error ||
            secretValues.some((secret) => text.includes(secret))
          )
            throw markFailover(httpError(502, 'upstream_unavailable'));
          return { text, usage: parseUsage(data.usage) };
        };
        let accepted = null;
        let lastError = httpError(502, 'upstream_unavailable');
        for (const provider of providers) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const attempt = await fetchProvider(provider);
          if (attempt.aborted) throw attempt.reason;
          if (!attempt.response) {
            lastError = attempt.error;
            upstreamStatus = attempt.status ?? upstreamStatus;
            if (provider.id === 'minimax' && attempt.failure) notePrimaryFailure(now());
            if (!attempt.failover) throw attempt.error;
            continue;
          }
          upstreamStatus = attempt.status;
          try {
            if (stream && !attempt.response.headers.get('content-type')?.includes('text/event-stream')) {
              await attempt.response.body.cancel().catch(() => {});
              throw markFailover(httpError(502, 'upstream_unavailable'));
            }
            const jsonBody = stream ? null : await readJsonBody(attempt.response);
            accepted = { provider, response: attempt.response, jsonBody };
            if (jsonBody && firstByteMs === null && jsonBody.text.length > 0)
              firstByteMs = Math.max(0, now() - startedAt);
            if (provider.id === 'minimax') {
              circuit.failures = 0;
              circuit.openUntil = 0;
              awayFromPrimary = false;
            } else awayFromPrimary = true;
            safeLog(`Provedor: ${provider.id} ${provider.model}`);
            break;
          } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            if (error?.failover) {
              lastError = httpError(502, 'upstream_unavailable');
              if (provider.id === 'minimax') notePrimaryFailure(now());
              continue;
            }
            throw error;
          }
        }
        if (!accepted) throw lastError;
        const served = accepted.provider;
        reader = stream ? accepted.response.body.getReader() : null;
        const sseReader = createSseReader(secretValues);
        if (stream) {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
            'X-JR-Provider': served.id,
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
        while (stream) {
          const next = await reader.read();
          if (controller.signal.aborted) throw controller.signal.reason;
          if (next.done) break;
          if (firstByteMs === null) firstByteMs = Math.max(0, now() - startedAt);
          await forwardSse(next.value);
        }
        if (stream) await forwardSse(undefined, true);
        else {
          usage = accepted.jsonBody.usage;
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-JR-Provider': served.id,
          });
          response.write(accepted.jsonBody.text);
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
    usingFallback() {
      return backups.length > 0 && (awayFromPrimary || circuitOpen(now()));
    },
  };
}
