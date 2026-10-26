import { randomUUID } from 'node:crypto';
import { compactMessages, estimateTokens } from './compact.mjs';
import {
  createSseReader,
  DEFAULT_ATTEMPT_MS,
  DEFAULT_COMPACTION_BUDGET_MS,
  DEFAULT_GEMINI_MODEL,
  GEMINI_URL,
  httpError,
  isHttpError,
  parseUsage,
} from './validation.mjs';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const PRIMARY_FAILURES = 3;
const CIRCUIT_OPEN_MS = 3 * 60 * 1000;
const HEADER_DEADLINE_MS = 180_000;
const PASSTHROUGH_STATUS = new Set([400, 413]);
const HEADER_SKIP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding',
  'authorization',
  'cookie',
  'set-cookie',
  'content-type',
  'cache-control',
]);

function oneLine(text) {
  return (
    String(text ?? '')
      // eslint-disable-next-line no-control-regex -- Remove control bytes from untrusted upstream text.
      .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 180)
  );
}

function reasonFromBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return 'erro_upstream';
  try {
    const data = JSON.parse(trimmed);
    const error = data?.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const parts = [error.code, error.type, error.message].filter((part) => typeof part === 'string' && part.trim());
      if (parts.length > 0) return parts.join(': ');
    }
  } catch {
    // Plain-text upstream errors are logged after redaction and truncation.
  }
  return trimmed;
}

function publicContentType(value, fallback) {
  if (typeof value !== 'string' || value.length > 160 || /[\r\n]/u.test(value)) return fallback;
  const media = value.split(';', 1)[0].trim().toLowerCase();
  if (!['application/json', 'application/problem+json', 'text/plain', 'text/event-stream'].includes(media))
    return fallback;
  return value;
}

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
  fallbackAttemptMs,
  attemptMs,
  compactionBudgetMs = DEFAULT_COMPACTION_BUDGET_MS,
  compactionEnabled = true,
  geminiKey,
  geminiModel,
}) {
  const headerTimeoutMs = fallbackAttemptMs ?? attemptMs ?? DEFAULT_ATTEMPT_MS;
  const backups = Array.isArray(fallback.providers) ? fallback.providers : [];
  const geminiProvider = backups.find((provider) => provider.id === 'gemini');
  const summarizer =
    typeof geminiKey === 'string' && geminiKey.length >= 16
      ? {
          key: geminiKey,
          model:
            geminiProvider?.model || (typeof geminiModel === 'string' && geminiModel.trim()) || DEFAULT_GEMINI_MODEL,
          url: geminiProvider?.url || GEMINI_URL,
          fetch: upstreamFetch,
        }
      : null;
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
      let deadline = setTimeout(() => controller.abort(httpError(504, 'upstream_timeout')), HEADER_DEADLINE_MS);
      deadline.unref();
      const disarmHeaderDeadline = () => {
        clearTimeout(deadline);
        deadline = null;
      };
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
        // AionRS autocompact always sends thinking disabled. MiniMax-M3.1 requires adaptive
        // thinking and answers 400 (2013), so every summary failed and the history kept growing.
        if (body.thinking?.type === 'disabled') delete body.thinking;
        if (body.reasoning_effort === 'none') delete body.reasoning_effort;
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
        if (compactionEnabled) {
          // Compaction has its own budget. The upstream header deadline must not abort it.
          disarmHeaderDeadline();
          try {
            body.messages = await compactMessages(body.messages, {
              gemini: summarizer,
              secrets: secretValues,
              attemptMs: headerTimeoutMs,
              budgetMs: compactionBudgetMs,
              now,
              signal: controller.signal,
              log: safeLog,
            });
          } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason ?? error;
            if (isHttpError(error)) throw error;
            safeLog('Compactação: falhou; pedido segue sem compactar');
          }
          if (!controller.signal.aborted) {
            deadline = setTimeout(() => controller.abort(httpError(504, 'upstream_timeout')), HEADER_DEADLINE_MS);
            deadline.unref();
          }
        }
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
        const readLimitedText = async (upstream, limit) => {
          if (!upstream.body) return '';
          const local = upstream.body.getReader();
          const chunks = [];
          let received = 0;
          try {
            while (received < limit) {
              if (controller.signal.aborted) throw controller.signal.reason;
              const next = await local.read();
              if (next.done) break;
              const room = limit - received;
              const slice = next.value.byteLength > room ? next.value.subarray(0, room) : next.value;
              chunks.push(slice);
              received += slice.byteLength;
              if (next.value.byteLength > room) break;
            }
          } finally {
            await local.cancel().catch(() => {});
          }
          return Buffer.concat(chunks).toString('utf8');
        };
        const redactText = (text) => {
          let output = text;
          for (const secret of secretValues) {
            if (secret) output = output.split(secret).join('[redacted]');
          }
          return output;
        };
        const clientHeaders = (upstream, providerId, fallbackType) => {
          const headers = {
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
            'X-Content-Type-Options': 'nosniff',
            'X-JR-Provider': providerId,
            'Content-Type': publicContentType(upstream.headers.get('content-type'), fallbackType),
          };
          upstream.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (HEADER_SKIP.has(lower) || lower.startsWith('x-jr-')) return;
            if (/authorization|api-key|cookie|token|secret/u.test(lower)) return;
            if (typeof value !== 'string' || value.length > 512 || /[\r\n]/u.test(value)) return;
            if (secretValues.some((secret) => value.includes(secret))) return;
            headers[key] = value;
          });
          return headers;
        };
        // The attempt timer aborts only while headers are pending. It is cleared before any body read,
        // so an in-progress SSE stream is not cut at ATTEMPT_MS.
        const fetchProvider = async (provider, hasNext) => {
          if (controller.signal.aborted) throw controller.signal.reason;
          const attempt = new AbortController();
          const abortAttempt = () => attempt.abort(controller.signal.reason);
          controller.signal.addEventListener('abort', abortAttempt, { once: true });
          let headersReceived = false;
          let timedOut = false;
          const timer = setTimeout(() => {
            if (headersReceived) return;
            timedOut = true;
            attempt.abort(httpError(504, 'upstream_timeout'));
          }, headerTimeoutMs);
          timer.unref();
          try {
            const upstream = await upstreamFetch(provider.url, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${provider.key}`,
                'Content-Type': 'application/json',
                Accept: stream ? 'text/event-stream' : 'application/json',
              },
              body: JSON.stringify({ ...payload, model: provider.model }),
              signal: attempt.signal,
              redirect: 'error',
            });
            headersReceived = true;
            clearTimeout(timer);
            if (controller.signal.aborted) throw controller.signal.reason;
            if (timedOut) {
              await upstream.body?.cancel().catch(() => {});
              return {
                failover: backups.length > 0,
                failure: true,
                status: 504,
                error: httpError(504, 'upstream_timeout'),
              };
            }
            if (PASSTHROUGH_STATUS.has(upstream.status)) {
              let text = '';
              try {
                text = await readLimitedText(upstream, 1024 * 1024);
              } catch (error) {
                if (controller.signal.aborted) return { aborted: true, reason: controller.signal.reason };
                text = '';
              }
              const bodyText = redactText(text);
              const reason = oneLine(reasonFromBody(bodyText));
              // Only the primary provider stops the chain. A fallback 400/413 tries the next provider.
              if (provider.id !== 'minimax' && hasNext) {
                return {
                  failover: true,
                  failure: false,
                  skippedStatus: true,
                  status: upstream.status,
                  model: provider.model,
                  reason,
                };
              }
              disarmHeaderDeadline();
              return {
                passthrough: true,
                status: upstream.status,
                model: provider.model,
                body: bodyText,
                contentType: publicContentType(upstream.headers.get('content-type'), 'text/plain; charset=utf-8'),
                reason,
              };
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
            disarmHeaderDeadline();
            return { response: upstream, status: upstream.status };
          } catch (error) {
            if (controller.signal.aborted) return { aborted: true, reason: controller.signal.reason };
            if (isHttpError(error) && !timedOut) throw error;
            return {
              failover: backups.length > 0,
              failure: true,
              status: timedOut ? 504 : null,
              error: httpError(timedOut ? 504 : 502, timedOut ? 'upstream_timeout' : 'upstream_unavailable'),
            };
          } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', abortAttempt);
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
        for (let index = 0; index < providers.length; index += 1) {
          const provider = providers[index];
          if (controller.signal.aborted) throw controller.signal.reason;
          const attempt = await fetchProvider(provider, index < providers.length - 1);
          if (attempt.aborted) throw attempt.reason;
          if (attempt.passthrough) {
            upstreamStatus = attempt.status;
            safeLog(
              `Erro upstream: status=${attempt.status} modelo=${attempt.model} tokens~${estimateTokens(payload)} motivo=${attempt.reason || 'erro_upstream'}`
            );
            status = 'failed';
            if (response.headersSent || response.destroyed) response.destroy();
            else {
              response.writeHead(attempt.status, {
                'Content-Type': attempt.contentType,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'X-JR-Provider': provider.id,
              });
              response.end(attempt.body ?? '');
            }
            return;
          }
          if (!attempt.response) {
            if (attempt.skippedStatus) {
              safeLog(
                `Erro upstream: status=${attempt.status} modelo=${attempt.model} tokens~${estimateTokens(payload)} motivo=${attempt.reason || 'erro_upstream'}; seguinte`
              );
            }
            lastError = attempt.error ?? lastError;
            upstreamStatus = attempt.status ?? upstreamStatus;
            if (provider.id === 'minimax' && attempt.failure) notePrimaryFailure(now());
            if (!attempt.failover) throw attempt.error;
            continue;
          }
          upstreamStatus = attempt.status;
          try {
            if (stream && !attempt.response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
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
          // Headers go out before the body is consumed. Frames are flushed as they complete;
          // the upstream SSE bytes are not buffered into a JSON document.
          response.writeHead(200, clientHeaders(accepted.response, served.id, 'text/event-stream; charset=utf-8'));
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
          response.writeHead(200, clientHeaders(accepted.response, served.id, 'application/json; charset=utf-8'));
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
        clearTimeout(deadline);
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
