import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export function parseProviderConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error('JR provider configuration is not valid JSON');
  }
  return loadProvider(config);
}

export async function probeHealth(url, timeoutMs = 1500) {
  return (await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })).ok;
}

export async function stopProcessGroup(pid, graceMs = 3000) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new Error('Invalid owned process group');
  const signal = (name) => {
    try {
      process.kill(-pid, name);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  if (!signal('SIGTERM')) return;
  const started = performance.now();
  while (performance.now() - started < graceMs) {
    if (!signal(0)) return;
    await delay(Math.min(25, graceMs));
  }
  signal('SIGKILL');
}

export function approvalWaitingMs(samples, finishedAt) {
  let start;
  let total = 0;
  for (const sample of samples) {
    if (sample.pending && start === undefined) start = sample.at;
    if (!sample.pending && start !== undefined) {
      total += sample.at - start;
      start = undefined;
    }
  }
  return Math.round(total + (start === undefined ? 0 : finishedAt - start));
}

export function summarizeTurnTiming(started, finished, events, calls, approvalSamples) {
  const apiTimes = calls
    .filter((call) => typeof call.firstTextMs === 'number')
    .map((call) => call.started + call.firstTextMs);
  const agentText = events.find((event) => event.type === 'content' && event.data?.content);
  const totalMs = Math.round(finished - started);
  const approvalWaitMs = approvalWaitingMs(approvalSamples, finished);
  return {
    totalMs,
    approvalWaitMs,
    processingMs: totalMs - approvalWaitMs,
    firstApiTextMs: apiTimes.length ? Math.round(Math.min(...apiTimes) - started) : null,
    firstAgentTextMs: agentText ? Math.round(agentText.receivedAt - started) : null,
  };
}

export function hasLocalExecution(events) {
  const calls = new Map();
  for (const event of events) {
    if (event.type !== 'tool_call' || !event.data?.call_id) continue;
    const call = event.data;
    calls.set(call.call_id, { ...calls.get(call.call_id), ...call });
  }
  return [...calls.values()].some(
    (call) =>
      call.name === 'ExecCommand' &&
      call.args?.cmd === '/opt/homebrew/bin/node calcular.mjs' &&
      call.status === 'completed' &&
      /^Exit code: 0\b/.test(call.output ?? '')
  );
}

export function loadProvider(config) {
  const provider = config?.provider?.['jr-minimax'];
  if (!provider) throw new Error('JR MiniMax provider is missing');
  const key = provider.options?.apiKey;
  if (typeof key !== 'string' || !key.trim() || key.startsWith('{')) {
    throw new Error('JR MiniMax credential is missing or unresolved');
  }
  let url;
  try {
    url = new URL(provider.options.baseURL);
  } catch {
    throw new Error('Invalid gateway URL');
  }
  if (
    url.origin !== 'https://jrsantafe.stratacerta.com.br' ||
    url.pathname.replace(/\/$/, '') !== '/mmx/v1' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Unexpected gateway URL');
  }
  const model = Object.keys(provider.models ?? {})[0];
  if (!model?.startsWith('MiniMax-')) throw new Error('Configured MiniMax model is missing');
  return { baseURL: url.href.replace(/\/$/, ''), key, model };
}

export async function verifyArtifact(workspace, marker, expectedTotal) {
  let file;
  try {
    file = await open(join(workspace, 'resultado.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error('Artifact must be a small regular file');
    const data = JSON.parse(await file.readFile('utf8'));
    if (data.marker !== marker) throw new Error('Artifact marker does not match this run');
    if (typeof data.total !== 'number' || Math.abs(data.total - expectedTotal) > 0.005) {
      throw new Error('Artifact total does not match the independent computation');
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Artifact was not created');
    if (error.code === 'ELOOP') throw new Error('Artifact must be a regular file, not a symlink');
    throw error;
  } finally {
    await file?.close();
  }
}

/** Local pilot/development relay: the gateway credential stays in this process. */
export async function startRelay(provider, { upstreamFetch = fetch } = {}) {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from('Bearer ' + token);
  const metrics = { requests: 0, calls: [] };
  const startedAt = new Date().toISOString();
  const pending = new Set();
  const server = createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const sendError = (status, message) => {
      if (!response.headersSent) response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message } }));
    };
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return sendError(401, 'Unauthorized');
    if (request.method === 'GET' && request.url === '/v1/jr/usage') {
      const calls = metrics.calls.filter((call) => call.path === '/v1/chat/completions');
      const reported = calls.filter(
        (call) => Number.isSafeInteger(call.usage?.prompt_tokens) && Number.isSafeInteger(call.usage?.completion_tokens)
      );
      const usage = reported.length
        ? {
            startedAt,
            promptTokens: reported.reduce((sum, call) => sum + call.usage.prompt_tokens, 0),
            completionTokens: reported.reduce((sum, call) => sum + call.usage.completion_tokens, 0),
            cachedPromptTokens: reported.reduce(
              (sum, call) => sum + (call.usage.prompt_tokens_details?.cached_tokens ?? 0),
              0
            ),
            modelRequests: calls.length,
          }
        : null;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ model: provider.model, usage }));
      return;
    }
    if (
      !(
        (request.method === 'POST' && request.url === '/v1/chat/completions') ||
        (request.method === 'GET' && request.url === '/v1/models')
      )
    )
      return sendError(404, 'Not found');
    const started = performance.now();
    const call = { started, method: request.method, path: request.url, model: provider.model };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    pending.add(controller);
    response.on('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) return sendError(413, 'Request too large');
        chunks.push(chunk);
      }
      let body = Buffer.concat(chunks);
      if (request.method === 'POST') {
        const input = JSON.parse(body.toString('utf8'));
        if (input.model !== provider.model) return sendError(400, 'Unexpected model');
        if (input.messages !== undefined && !Array.isArray(input.messages)) return sendError(400, 'Invalid messages');
        const policy =
          'Responda sempre em português do Brasil, inclusive nas mensagens de andamento. Seja claro e breve. Não apresente raciocínio interno. Preserve literalmente arquivos, comandos, parâmetros, endereços e resultados das ferramentas. Mantenha todas as regras de confirmação e segurança anteriores.';
        input.messages ??= [];
        const system = input.messages.find(
          (message) => message?.role === 'system' && typeof message.content === 'string'
        );
        if (system) system.content += '\n\n' + policy;
        else input.messages.unshift({ role: 'system', content: policy });
        body = Buffer.from(JSON.stringify(input));
        call.inputBytes = body.length;
        call.availableTools = input.tools?.length ?? 0;
      }
      metrics.requests++;
      metrics.calls.push(call);
      const upstream = await upstreamFetch(provider.baseURL + request.url.slice(3), {
        method: request.method,
        headers: { Authorization: 'Bearer ' + provider.key, 'Content-Type': 'application/json' },
        ...(request.method === 'POST' ? { body } : {}),
        redirect: 'error',
        signal: controller.signal,
      });
      call.status = upstream.status;
      if (!upstream.ok) {
        call.error = 'UPSTREAM_HTTP_ERROR';
        return sendError(upstream.status, 'Gateway request failed');
      }
      response.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
      let buffer = '';
      const isSse = upstream.headers.get('content-type')?.includes('text/event-stream');
      const inspect = (line) => {
        if (!line.startsWith('data: ')) return;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.choices?.[0]?.delta?.content && call.firstTextMs === undefined)
            call.firstTextMs = Math.round(performance.now() - started);
          if (event.usage) call.usage = event.usage;
          if (event.model) call.model = event.model;
        } catch {
          /* SSE terminator and partial events carry no metrics. */
        }
      };
      const decoder = new TextDecoder();
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while (isSse && (newline = buffer.indexOf('\n')) >= 0) {
          inspect(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        if (buffer.length > 2 * 1024 * 1024) buffer = '';
        if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
      }
      if (!isSse) {
        try {
          const event = JSON.parse(buffer);
          if (event.choices?.[0]?.message?.content) call.firstTextMs = Math.round(performance.now() - started);
          if (event.usage) call.usage = event.usage;
          if (event.model) call.model = event.model;
        } catch {
          /* An invalid upstream response is passed through without inventing metrics. */
        }
      }
      call.totalMs = Math.round(performance.now() - started);
      response.end();
    } catch (error) {
      call.error = error.name;
      sendError(502, 'Gateway connection failed');
    } finally {
      clearTimeout(timer);
      pending.delete(controller);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    token,
    metrics,
    async close() {
      for (const controller of pending) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
