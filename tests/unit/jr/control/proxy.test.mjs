import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { MODEL, startControl, UPSTREAM_KEY } from './support.mjs';

test('model proxy uses only configured credentials and records real non-stream usage per employee', async (t) => {
  let forwarded;
  const app = await startControl(t, {
    upstreamFetch: async (url, options) => {
      forwarded = { url, options, body: JSON.parse(options.body) };
      return Response.json({
        model: MODEL,
        choices: [{ message: { role: 'assistant', content: 'Olá' } }],
        usage: { prompt_tokens: 25, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 10 } },
      });
    },
  });
  const owner = await app.login();
  const invitation = await app.invite(owner.token);
  const employee = await app.login(invitation.code, 'usage');
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: employee.token,
    body: { model: MODEL, messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'Olá');
  assert.equal(forwarded.url, 'https://jrsantafe.stratacerta.com.br/mmx/v1/chat/completions');
  assert.equal(forwarded.options.headers.Authorization, `Bearer ${UPSTREAM_KEY}`);
  assert.equal(forwarded.body.model, MODEL);
  assert.equal(JSON.stringify(forwarded.body).includes(employee.token), false);
  const { usage } = await (await app.request('/usage', { token: employee.token })).json();
  assert.equal(usage.requests, 1);
  assert.equal(usage.promptTokens, 25);
  assert.equal(usage.completionTokens, 7);
  assert.equal(usage.cachedPromptTokens, 10);
  assert.equal(usage.tokensLast5h, 32);
  assert.equal(usage.tokensThisWeek, 32);
  assert.equal(usage.daily.at(-1).tokens, 32);
  assert.equal(usage.daily.at(-1).requests, 1);
  assert.equal(usage.peak5h.find((peak) => peak.days === 7).tokens, 32);
  assert.equal((await (await app.request('/usage', { token: owner.token })).json()).usage, null);
});

test('usage remains unknown when provider omits counts and foreign models are refused before billing', async (t) => {
  let calls = 0;
  const app = await startControl(t, {
    upstreamFetch: async () => {
      calls += 1;
      return Response.json({ choices: [] });
    },
  });
  const owner = await app.login();
  assert.equal(
    (
      await app.request('/v1/chat/completions', {
        method: 'POST',
        token: owner.token,
        body: { model: 'foreign-model', messages: [{ role: 'user', content: 'Olá' }] },
      })
    ).status,
    400
  );
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  await response.json();
  const { usage } = await (await app.request('/usage', { token: owner.token })).json();
  assert.equal(calls, 1);
  assert.equal(usage.promptTokens, null);
  assert.equal(usage.completionTokens, null);
  assert.equal(usage.unmeteredRequests, 1);
});

test('a stored token limit is kept but does not block further model requests', async (t) => {
  let upstreamCalls = 0;
  const app = await startControl(t, {
    upstreamFetch: async () => {
      upstreamCalls += 1;
      return Response.json({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    },
  });
  const owner = await app.login();
  const invitation = await app.invite(owner.token, 'Limite de tokens');
  const employee = await app.login(invitation.code, 'token-limit');
  const policy = await app.request(`/admin/employees/${invitation.id}/policy`, {
    method: 'POST',
    token: owner.token,
    body: { tokenLimit: 15, accessStart: null, accessEnd: null },
  });
  assert.equal(policy.status, 200);
  const request = {
    method: 'POST',
    token: employee.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  };
  assert.equal((await app.request('/v1/chat/completions', request)).status, 200);
  const continued = await app.request('/v1/chat/completions', request);
  assert.equal(continued.status, 200);
  assert.equal(upstreamCalls, 2);
  const usage = await (await app.request('/usage', { token: employee.token })).json();
  assert.equal(usage.usage.totalTokens, 30);
  assert.equal(usage.usage.tokensLast5h, 30);
  const listed = await (await app.request('/admin/employees', { token: owner.token })).json();
  assert.equal(listed.employees[0].tokenLimit, 15);
});

test('stream passes through UTF-8 and split SSE frames while recording the final cumulative usage once', async (t) => {
  const encoder = new TextEncoder();
  const payload =
    'data: {"choices":[{"delta":{"content":"Olá, ação"}}]}\r\n\r\ndata: {"usage":{"prompt_tokens":30,"completion_tokens":5}}\n\ndata: {"usage":{"prompt_tokens":30,"completion_tokens":8}}\n\ndata: [DONE]\n\n';
  const bytes = encoder.encode(payload);
  let forwarded;
  const app = await startControl(t, {
    upstreamFetch: async (_url, options) => {
      forwarded = JSON.parse(options.body);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { stream: true, messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(await response.text(), payload);
  assert.equal(forwarded.stream_options.include_usage, true);
  const { usage } = await (await app.request('/usage', { token: owner.token })).json();
  assert.equal(usage.promptTokens, 30);
  assert.equal(usage.completionTokens, 8);
  assert.equal(usage.meteredRequests, 1);
});

test('revoking an employee aborts an in-flight upstream request and later model calls are denied', async (t) => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let markAborted;
  const aborted = new Promise((resolve) => {
    markAborted = resolve;
  });
  const app = await startControl(t, {
    upstreamFetch: async (_url, { signal }) => {
      markStarted();
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            markAborted();
            reject(signal.reason);
          },
          { once: true }
        )
      );
    },
  });
  const owner = await app.login();
  const invite = await app.invite(owner.token);
  const employee = await app.login(invite.code, 'abort');
  const request = app.request('/v1/chat/completions', {
    method: 'POST',
    token: employee.token,
    body: { messages: [{ role: 'user', content: 'Aguarde' }] },
  });
  await started;
  await app.request(`/admin/employees/${invite.id}/revoke`, { method: 'POST', token: owner.token });
  await aborted;
  assert.equal((await request).status, 401);
  assert.equal((await app.request('/v1/models', { token: employee.token })).status, 401);
});

test('upstream errors never return server credentials and malformed requests do not reach the provider', async (t) => {
  let calls = 0;
  const app = await startControl(t, {
    upstreamFetch: async () => {
      calls += 1;
      throw new Error(`private: ${UPSTREAM_KEY}`);
    },
  });
  const owner = await app.login();
  const invalid = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: 'unsafe' },
  });
  assert.equal(invalid.status, 400);
  const failed = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: { code: 'upstream_unavailable' } });
  assert.equal(calls, 1);
});

test('provider exceptions cannot masquerade as public HTTP errors containing credentials', async (t) => {
  const app = await startControl(t, {
    upstreamFetch: async () => {
      throw Object.assign(new Error('private provider failure'), { status: 401, code: UPSTREAM_KEY });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: 'upstream_unavailable' } });
});

test('JSON provider errors with success status are not forwarded as model answers', async (t) => {
  const app = await startControl(t, {
    upstreamFetch: async () => Response.json({ error: { message: 'Provider failure' } }),
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: 'upstream_unavailable' } });
});

test('split SSE provider errors never expose configured credentials', async (t) => {
  const bytes = new TextEncoder().encode(`data: {"error":{"message":"Invalid key ${UPSTREAM_KEY}"}}\n\n`);
  const app = await startControl(t, {
    upstreamFetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      ),
  });
  const owner = await app.login();
  const chunks = [];
  try {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      token: owner.token,
      body: { stream: true, messages: [{ role: 'user', content: 'Olá' }] },
    });
    for await (const chunk of response.body) chunks.push(chunk);
  } catch {
    // A rejected provider stream is terminated rather than forwarding private error content.
  }
  assert.equal(Buffer.concat(chunks).toString('utf8').includes(UPSTREAM_KEY), false);
});

test('revocation cancels a live SSE reader and records already-reported counters without storing content', async (t) => {
  let cancelled = false;
  const app = await startControl(t, {
    upstreamFetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n')
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      ),
  });
  const owner = await app.login();
  const invitation = await app.invite(owner.token);
  const employee = await app.login(invitation.code, 'stream-cancel');
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: employee.token,
    body: { stream: true, messages: [{ role: 'user', content: 'Olá' }] },
  });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  await app.request(`/admin/employees/${invitation.id}/revoke`, { method: 'POST', token: owner.token });
  await assert.rejects(reader.read());
  assert.equal(cancelled, true);
  const { employees } = await (await app.request('/admin/employees', { token: owner.token })).json();
  assert.equal(employees[0].usage.promptTokens, 11);
  assert.equal(employees[0].usage.completedRequests, 0);
});

test('concurrent model requests are bounded and logout releases all held requests', async (t) => {
  let count = 0;
  let markReady;
  const ready = new Promise((resolve) => {
    markReady = resolve;
  });
  const app = await startControl(t, {
    upstreamFetch: async (_url, { signal }) => {
      count += 1;
      if (count === 4) markReady();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      );
    },
  });
  const owner = await app.login();
  const body = { messages: [{ role: 'user', content: 'Aguarde' }] };
  const held = Array.from({ length: 4 }, () =>
    app.request('/v1/chat/completions', { method: 'POST', token: owner.token, body })
  );
  await ready;
  assert.equal((await app.request('/v1/chat/completions', { method: 'POST', token: owner.token, body })).status, 429);
  await app.request('/auth/logout', { method: 'POST', token: owner.token });
  assert.deepEqual(
    (await Promise.all(held)).map((response) => response.status),
    [401, 401, 401, 401]
  );
});

test('concurrency limits include uploads before full request bodies are buffered', async (t) => {
  const app = await startControl(t);
  const owner = await app.login();
  const uploads = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      const upload = httpRequest(`${app.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json', Expect: '100-continue' },
      });
      upload.on('error', () => {});
      uploads.push(upload);
      const continued = once(upload, 'continue');
      upload.flushHeaders();
      await continued;
      upload.write('{"messages":[');
    }
    const overflow = await app.request('/v1/chat/completions', {
      method: 'POST',
      token: owner.token,
      body: { messages: [{ role: 'user', content: 'Olá' }] },
    });
    assert.equal(overflow.status, 429);
  } finally {
    for (const upload of uploads) upload.destroy();
  }
});

test('company presentation policy stays Portuguese while preserving tool and file bytes', async (t) => {
  let forwarded;
  const app = await startControl(t, {
    upstreamFetch: async (_url, options) => {
      forwarded = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: 'Pronto.' } }] });
    },
  });
  const owner = await app.login();
  const messages = [
    { role: 'system', content: 'Keep approvals enabled.' },
    { role: 'user', content: 'node script.mjs --name="Hello"' },
  ];
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { model: MODEL, messages },
  });
  await response.text();
  assert.equal(response.status, 200);
  assert.match(forwarded.messages[0].content, /português do Brasil/);
  assert.match(forwarded.messages[0].content, /Keep approvals enabled/);
  assert.match(forwarded.messages[0].content, /não é da área técnica/);
  assert.deepEqual(forwarded.messages[1], messages[1]);
});

test('AionRS compaction asks for disabled thinking, which MiniMax rejects, so the field is dropped', async (t) => {
  let forwarded;
  const app = await startControl(t, {
    upstreamFetch: async (_url, options) => {
      forwarded = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: '<summary>ok</summary>' } }] });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: {
      model: MODEL,
      messages: [{ role: 'user', content: 'Respond with TEXT ONLY.' }],
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
      max_tokens: 20000,
    },
  });
  await response.text();
  assert.equal(response.status, 200);
  assert.equal('thinking' in forwarded, false);
  assert.equal('reasoning_effort' in forwarded, false);
  assert.equal(forwarded.max_tokens, 20000);
  // The summary keeps paths and technical detail; the plain-language rule is for employees.
  assert.doesNotMatch(forwarded.messages[0].content, /não é da área técnica/);
});

const OPENROUTER_KEY = 'openrouter-test-key-not-real';
const GEMINI_KEY = 'gemini-test-key-not-real-xx';
const MINIMAX_URL = 'https://jrsantafe.stratacerta.com.br/mmx/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

test('a failed MiniMax call is replayed on OpenRouter with the same tools and stream', async (t) => {
  const logs = [];
  const calls = [];
  const tools = [{ type: 'function', function: { name: 'list_files', parameters: { type: 'object' } } }];
  const app = await startControl(t, {
    log: (line) => logs.push(line),
    openRouterKey: OPENROUTER_KEY,
    openRouterModels: 'deepseek/deepseek-chat:free',
    upstreamFetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, authorization: options.headers.Authorization, body });
      if (url === MINIMAX_URL) throw new Error(`network down ${UPSTREAM_KEY}`);
      const encoder = new TextEncoder();
      const payload =
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"list_files","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n';
      return new Response(encoder.encode(payload), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { stream: true, tools, messages: [{ role: 'user', content: 'Liste' }] },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-jr-provider'), 'openrouter');
  assert.match(await response.text(), /list_files/);
  assert.equal(calls[0].url, MINIMAX_URL);
  assert.equal(calls[1].url, OPENROUTER_URL);
  assert.equal(calls[1].authorization, `Bearer ${OPENROUTER_KEY}`);
  assert.equal(calls[1].body.model, 'openrouter/free');
  assert.deepEqual(calls[1].body.tools, tools);
  assert.equal(calls[1].body.stream_options.include_usage, true);
  assert.deepEqual(logs, ['Provedor: openrouter openrouter/free']);
  assert.equal(logs.join('\n').includes(OPENROUTER_KEY), false);
  assert.equal(logs.join('\n').includes(UPSTREAM_KEY), false);
  const usage = await (await app.request('/usage', { token: owner.token })).json();
  assert.equal(usage.fallback, true);
});

test('OpenRouter rate limits walk the free list and then Gemini', async (t) => {
  const calls = [];
  const app = await startControl(t, {
    log: () => {},
    openRouterKey: OPENROUTER_KEY,
    openRouterModels: 'deepseek/deepseek-chat:free,qwen/qwen3-coder:free',
    geminiKey: GEMINI_KEY,
    upstreamFetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, model: body.model, authorization: options.headers.Authorization, tools: body.tools });
      if (url === MINIMAX_URL) return new Response('unavailable', { status: 401 });
      if (url === OPENROUTER_URL) return new Response('busy', { status: 429 });
      assert.equal(options.headers.Authorization, `Bearer ${GEMINI_KEY}`);
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'save', arguments: '{"ok":true}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: {
      tools: [{ type: 'function', function: { name: 'save' } }],
      messages: [{ role: 'user', content: 'Salve' }],
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-jr-provider'), 'gemini');
  const payload = await response.json();
  assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'save');
  assert.deepEqual(
    calls.map((call) => call.model),
    [
      'MiniMax-M3.1-Flash',
      'openrouter/free',
      'deepseek/deepseek-chat:free',
      'qwen/qwen3-coder:free',
      'gemini-3.8-flash',
    ]
  );
  assert.equal(calls.at(-1).url, GEMINI_URL);
  assert.equal(JSON.stringify(payload).includes(GEMINI_KEY), false);
  const { usage } = await (await app.request('/usage', { token: owner.token })).json();
  assert.equal(usage.completionTokens, 2);
});

test('exhausted fallbacks stay private and a closed switch never leaves MiniMax', async (t) => {
  let calls = 0;
  const logs = [];
  const disabled = await startControl(t, {
    log: (line) => logs.push(line),
    openRouterKey: OPENROUTER_KEY,
    geminiKey: GEMINI_KEY,
    fallbackEnabled: 'false',
    upstreamFetch: async () => {
      calls += 1;
      return new Response(`denied ${OPENROUTER_KEY}`, { status: 503 });
    },
  });
  const owner = await disabled.login();
  const blocked = await disabled.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(blocked.status, 502);
  assert.deepEqual(await blocked.json(), { error: { code: 'upstream_unavailable' } });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(logs).includes(OPENROUTER_KEY), false);

  const logsAgain = [];
  const exhausted = await startControl(t, {
    log: (line) => logsAgain.push(line),
    openRouterKey: OPENROUTER_KEY,
    geminiKey: GEMINI_KEY,
    upstreamFetch: async () => new Response(`secret ${GEMINI_KEY}`, { status: 429 }),
  });
  const again = await exhausted.login();
  const failed = await exhausted.request('/v1/chat/completions', {
    method: 'POST',
    token: again.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(failed.status, 502);
  assert.equal((await failed.text()).includes(GEMINI_KEY), false);
  assert.equal(JSON.stringify(logsAgain).includes(GEMINI_KEY), false);
  assert.equal(JSON.stringify(logsAgain).includes(OPENROUTER_KEY), false);
});

test('three MiniMax failures skip it until the cooling window ends', async (t) => {
  let clock = Date.parse('2026-10-23T12:00:00.000Z');
  let primaryUp = false;
  const calls = [];
  const logs = [];
  const app = await startControl(t, {
    now: () => clock,
    log: (line) => logs.push(line),
    openRouterKey: OPENROUTER_KEY,
    upstreamFetch: async (url) => {
      calls.push(url);
      if (url === MINIMAX_URL) {
        if (!primaryUp) return new Response('down', { status: 503 });
        return Response.json({
          choices: [{ message: { content: 'MiniMax' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      }
      return Response.json({
        choices: [{ message: { content: 'livre' } }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      });
    },
  });
  const owner = await app.login();
  const body = { messages: [{ role: 'user', content: 'Olá' }] };
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await app.request('/v1/chat/completions', { method: 'POST', token: owner.token, body })).status, 200);
  }
  calls.length = 0;
  const cooled = await app.request('/v1/chat/completions', { method: 'POST', token: owner.token, body });
  assert.equal(cooled.status, 200);
  assert.deepEqual(calls, [OPENROUTER_URL]);
  assert.equal((await (await app.request('/usage', { token: owner.token })).json()).fallback, true);
  clock += 3 * 60 * 1000 + 1;
  primaryUp = true;
  calls.length = 0;
  const restored = await app.request('/v1/chat/completions', { method: 'POST', token: owner.token, body });
  assert.equal((await restored.json()).choices[0].message.content, 'MiniMax');
  assert.deepEqual(calls, [MINIMAX_URL]);
  assert.equal((await (await app.request('/usage', { token: owner.token })).json()).fallback, undefined);
  assert.equal(logs.includes('Provedor: circuito aberto'), true);
  assert.equal(logs.join('\n').includes(OPENROUTER_KEY), false);
});

test('a MiniMax timeout is retried on OpenRouter before the client deadline', async (t) => {
  const calls = [];
  const app = await startControl(t, {
    log: () => {},
    fallbackAttemptMs: 30,
    openRouterKey: OPENROUTER_KEY,
    upstreamFetch: async (url, options) => {
      calls.push(url);
      if (url !== MINIMAX_URL) return Response.json({ choices: [{ message: { content: 'depois' } }] });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'depois');
  assert.deepEqual(calls, [MINIMAX_URL, OPENROUTER_URL]);
});

test('provider 400 is forwarded as 400 and does not fall through to another provider', async (t) => {
  let calls = 0;
  const logs = [];
  const app = await startControl(t, {
    log: (line) => logs.push(line),
    openRouterKey: OPENROUTER_KEY,
    openRouterModels: 'deepseek/deepseek-chat:free',
    upstreamFetch: async () => {
      calls += 1;
      return new Response(`bad request ${UPSTREAM_KEY}`, {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(text, /bad request/);
  assert.equal(text.includes(UPSTREAM_KEY), false);
  assert.equal(calls, 1);
  assert.match(logs.join('\n'), /Erro upstream: status=400 modelo=MiniMax-M3.1-Flash tokens~\d+ motivo=/);
  assert.equal(logs.join('\n').includes(UPSTREAM_KEY), false);
  const leaked = await startControl(t, {
    log: () => {},
    openRouterKey: OPENROUTER_KEY,
    geminiKey: GEMINI_KEY,
    upstreamFetch: async (url) => {
      calls += 1;
      if (url === GEMINI_URL) return Response.json({ choices: [{ message: { content: 'limpo' } }] });
      return Response.json({ error: { message: OPENROUTER_KEY } });
    },
  });
  const second = await leaked.login();
  const recovered = await leaked.request('/v1/chat/completions', {
    method: 'POST',
    token: second.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.text()).includes(OPENROUTER_KEY), false);
  assert.equal(recovered.headers.get('x-jr-provider'), 'gemini');
});

test('provider 413 is forwarded as 413 with the upstream reason and does not open the fallback chain', async (t) => {
  const logs = [];
  const calls = [];
  const app = await startControl(t, {
    log: (line) => logs.push(line),
    openRouterKey: OPENROUTER_KEY,
    geminiKey: GEMINI_KEY,
    upstreamFetch: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ error: { code: 'context_length', message: `too large ${UPSTREAM_KEY}` } }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  const payload = await response.json();
  assert.equal(response.status, 413);
  assert.equal(payload.error.code, 'context_length');
  assert.equal(JSON.stringify(payload).includes(UPSTREAM_KEY), false);
  assert.deepEqual(calls, [MINIMAX_URL]);
  assert.match(logs.join('\n'), /Erro upstream: status=413 modelo=MiniMax-M3.1-Flash tokens~\d+ motivo=/);
  assert.match(logs.join('\n'), /context_length/);
  assert.equal(logs.join('\n').includes(UPSTREAM_KEY), false);
});

test('OpenRouter and Gemini 400 or 413 continue until the next provider', async (t) => {
  const logs = [];
  const calls = [];
  const recovered = await startControl(t, {
    log: (line) => logs.push(line),
    openRouterKey: OPENROUTER_KEY,
    geminiKey: GEMINI_KEY,
    upstreamFetch: async (url) => {
      calls.push(url);
      if (url === MINIMAX_URL) return new Response('down', { status: 503 });
      if (url === OPENROUTER_URL) {
        return new Response(JSON.stringify({ error: { message: 'bad tools' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return Response.json({ choices: [{ message: { content: 'gemini-ok' } }] });
    },
  });
  const owner = await recovered.login();
  const response = await recovered.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /gemini-ok/);
  assert.equal(response.headers.get('x-jr-provider'), 'gemini');
  assert.deepEqual(calls, [MINIMAX_URL, OPENROUTER_URL, GEMINI_URL]);
  assert.match(logs.join('\n'), /Erro upstream: status=400 modelo=openrouter\/free tokens~\d+ motivo=.*seguinte/);

  for (const status of [400, 413]) {
    const chain = [];
    const app = await startControl(t, {
      log: () => {},
      openRouterKey: OPENROUTER_KEY,
      openRouterModels: 'deepseek/deepseek-chat:free',
      geminiKey: GEMINI_KEY,
      upstreamFetch: async (url, options) => {
        const model = JSON.parse(options.body).model;
        chain.push({ url, model });
        if (url === MINIMAX_URL) return new Response('down', { status: 503 });
        if (url === OPENROUTER_URL) {
          return new Response(JSON.stringify({ error: { message: `openrouter-${status}` } }), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return Response.json({ choices: [{ message: { content: `depois-${status}` } }] });
      },
    });
    const session = await app.login();
    const next = await app.request('/v1/chat/completions', {
      method: 'POST',
      token: session.token,
      body: { messages: [{ role: 'user', content: 'Olá' }] },
    });
    assert.equal(next.status, 200);
    assert.match(await next.text(), new RegExp(`depois-${status}`));
    assert.deepEqual(
      chain.map((call) => call.url),
      [MINIMAX_URL, OPENROUTER_URL, OPENROUTER_URL, GEMINI_URL]
    );
    assert.deepEqual(
      chain.map((call) => call.model),
      [MODEL, 'openrouter/free', 'deepseek/deepseek-chat:free', 'gemini-3.8-flash']
    );
  }
});

test('the last fallback provider returns its own 400 or 413', async (t) => {
  const calls = [];
  const app = await startControl(t, {
    log: () => {},
    openRouterKey: OPENROUTER_KEY,
    geminiKey: GEMINI_KEY,
    upstreamFetch: async (url) => {
      calls.push(url);
      if (url === MINIMAX_URL) return new Response('down', { status: 503 });
      if (url === OPENROUTER_URL) {
        return new Response(JSON.stringify({ error: { message: 'bad tools' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { message: `gemini recusou ${GEMINI_KEY}` } }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  const text = await response.text();
  assert.equal(response.status, 413);
  assert.match(text, /gemini recusou/);
  assert.equal(text.includes(GEMINI_KEY), false);
  assert.equal(response.headers.get('x-jr-provider'), 'gemini');
  assert.deepEqual(calls, [MINIMAX_URL, OPENROUTER_URL, GEMINI_URL]);

  const onlyRouter = [];
  const router = await startControl(t, {
    log: () => {},
    openRouterKey: OPENROUTER_KEY,
    upstreamFetch: async (url) => {
      onlyRouter.push(url);
      if (url === MINIMAX_URL) return new Response('down', { status: 503 });
      return new Response(JSON.stringify({ error: { message: 'ultimo-free' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const second = await router.login();
  const last = await router.request('/v1/chat/completions', {
    method: 'POST',
    token: second.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(last.status, 400);
  assert.match(await last.text(), /ultimo-free/);
  assert.equal(last.headers.get('x-jr-provider'), 'openrouter');
  assert.deepEqual(onlyRouter, [MINIMAX_URL, OPENROUTER_URL]);
});

test('repeated MiniMax 400 responses stay on MiniMax', async (t) => {
  const calls = [];
  const app = await startControl(t, {
    log: () => {},
    openRouterKey: OPENROUTER_KEY,
    upstreamFetch: async (url) => {
      calls.push(url);
      return new Response('no', { status: 400 });
    },
  });
  const owner = await app.login();
  const body = { messages: [{ role: 'user', content: 'Olá' }] };
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await app.request('/v1/chat/completions', { method: 'POST', token: owner.token, body })).status, 400);
  }
  assert.deepEqual(calls, [MINIMAX_URL, MINIMAX_URL, MINIMAX_URL]);
});

test('GEMINI_MODEL overrides the fallback model', async (t) => {
  const models = [];
  const app = await startControl(t, {
    log: () => {},
    geminiKey: GEMINI_KEY,
    geminiModel: 'gemini-3.8-pro',
    upstreamFetch: async (url, options) => {
      models.push(JSON.parse(options.body).model);
      if (url === MINIMAX_URL) return new Response('denied', { status: 401 });
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(models, [MODEL, 'gemini-3.8-pro']);
});

test('stream SSE headers and the first frame arrive before the upstream body ends', { timeout: 5_000 }, async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const encoder = new TextEncoder();
  const app = await startControl(t, {
    upstreamFetch: async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'));
            await gate;
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Upstream-Trace': 'trace-1' } }
      ),
  });
  const owner = await app.login();
  const response = await Promise.race([
    app.request('/v1/chat/completions', {
      method: 'POST',
      token: owner.token,
      body: { stream: true, messages: [{ role: 'user', content: 'Olá' }] },
    }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('headers late')), 1_000)),
  ]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('x-upstream-trace'), 'trace-1');
  assert.equal(response.headers.get('content-type').includes('application/json'), false);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value).toString('utf8'), /"A"/);
  release();
  let rest = '';
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    rest += Buffer.from(next.value).toString('utf8');
  }
  assert.match(rest, /\[DONE\]/);
});

test('the attempt timeout stops at the headers and does not cut an open stream', { timeout: 5_000 }, async (t) => {
  const calls = [];
  const encoder = new TextEncoder();
  const app = await startControl(t, {
    log: () => {},
    fallbackAttemptMs: 80,
    openRouterKey: OPENROUTER_KEY,
    upstreamFetch: async (url, options) => {
      calls.push(url);
      if (url !== MINIMAX_URL) throw new Error(`provedor inesperado ${url}`);
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"um"}}]}\n\n'));
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (options.signal?.aborted) {
              controller.error(options.signal.reason ?? new Error('aborted'));
              return;
            }
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"dois"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { stream: true, messages: [{ role: 'user', content: 'Olá' }] },
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /um/);
  assert.match(text, /dois/);
  assert.equal(response.headers.get('x-jr-provider'), 'minimax');
  assert.deepEqual(calls, [MINIMAX_URL]);
});

function assertCompactShape(messages) {
  const systems = messages.filter((message) => message.role === 'system');
  assert.ok(systems.length <= 1);
  if (systems.length === 1) assert.equal(messages[0].role, 'system');
  for (let index = 1; index < messages.length; index += 1) {
    assert.notEqual(messages[index].role, messages[index - 1].role);
  }
}

function longContext() {
  const messages = [{ role: 'system', content: 'Regras fixas.' }];
  for (let index = 0; index < 8; index += 1) {
    messages.push({
      role: 'user',
      content: `INICIO-${index}-${'x'.repeat(35_000)}MEIO-UNICO-${index}${'y'.repeat(35_000)}-FIM-${index}`,
    });
  }
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_new', type: 'function', function: { name: 'save', arguments: '{"path":"a.txt"}' } }],
  });
  messages.push({ role: 'tool', tool_call_id: 'call_new', content: 'ok-salvo' });
  messages.push({ role: 'user', content: 'ULTIMA-MENSAGEM' });
  return messages;
}

test('context over 140k tokens is excerpted without Gemini when no key is configured', async (t) => {
  const calls = [];
  let forwarded;
  const app = await startControl(t, {
    upstreamFetch: async (url, options) => {
      calls.push(url);
      forwarded = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  const owner = await app.login();
  const messages = longContext();
  assert.ok(Math.ceil(JSON.stringify(messages).length / 3) > 140_000);
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [MINIMAX_URL]);
  const sent = JSON.stringify(forwarded.messages);
  assert.ok(Math.ceil(sent.length / 3) <= 130_000);
  assert.match(sent, /ULTIMA-MENSAGEM/);
  assert.match(sent, /ok-salvo/);
  assert.match(sent, /call_new/);
  assert.match(sent, /Regras fixas/);
  assert.match(sent, /português do Brasil/);
  assert.equal(sent.includes('MEIO-UNICO-0'), false);
  assert.match(sent, /contexto compactado/);
  assertCompactShape(forwarded.messages);
});

test('a long context uses Gemini summaries and still sends the recent tool pair', async (t) => {
  const summaryCalls = [];
  let forwarded;
  const app = await startControl(t, {
    log: () => {},
    geminiKey: GEMINI_KEY,
    upstreamFetch: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url === GEMINI_URL) {
        summaryCalls.push(body);
        assert.equal(body.stream, false);
        return Response.json({ choices: [{ message: { content: 'Resumo fiel dos arquivos.' } }] });
      }
      forwarded = body;
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: longContext() },
  });
  assert.equal(response.status, 200);
  assert.ok(summaryCalls.length > 0);
  assert.equal(summaryCalls[0].model, 'gemini-3.8-flash');
  assert.match(summaryCalls[0].messages.at(-1).content, /MEIO-UNICO-0/);
  const sent = JSON.stringify(forwarded.messages);
  assert.match(sent, /Resumo fiel dos arquivos/);
  assert.match(sent, /ULTIMA-MENSAGEM/);
  assert.match(sent, /ok-salvo/);
  assert.equal(sent.includes('MEIO-UNICO-0'), false);
  assert.ok(Math.ceil(sent.length / 3) <= 130_000);
  assert.equal(JSON.stringify(forwarded).includes(GEMINI_KEY), false);
  assertCompactShape(forwarded.messages);
});

test('Gemini 400 and 413 while summarizing still deliver the original request', async (t) => {
  for (const status of [400, 413]) {
    let forwarded;
    const app = await startControl(t, {
      log: () => {},
      geminiKey: GEMINI_KEY,
      upstreamFetch: async (url, options) => {
        if (url === GEMINI_URL)
          return new Response(JSON.stringify({ error: { message: 'resumo recusado' } }), { status });
        forwarded = JSON.parse(options.body);
        return Response.json({ choices: [{ message: { content: 'seguiu' } }] });
      },
    });
    const owner = await app.login();
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      token: owner.token,
      body: { messages: longContext() },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'seguiu');
    const sent = JSON.stringify(forwarded.messages);
    assert.match(sent, /contexto compactado/);
    assert.match(sent, /ULTIMA-MENSAGEM/);
    assert.equal(sent.includes('MEIO-UNICO-0'), false);
    assertCompactShape(forwarded.messages);
  }
});

test('a hung Gemini summary falls back to an excerpt and the user request succeeds', { timeout: 5_000 }, async (t) => {
  let forwarded;
  const app = await startControl(t, {
    log: () => {},
    fallbackAttemptMs: 40,
    geminiKey: GEMINI_KEY,
    upstreamFetch: async (url, options) => {
      if (url === GEMINI_URL) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
      forwarded = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: 'depois do resumo' } }] });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: longContext() },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'depois do resumo');
  assert.match(JSON.stringify(forwarded.messages), /contexto compactado/);
  assert.match(JSON.stringify(forwarded.messages), /ULTIMA-MENSAGEM/);
  assertCompactShape(forwarded.messages);
});

test('a system prompt over the ceiling is truncated and the latest user turn is kept', async (t) => {
  let forwarded;
  const app = await startControl(t, {
    upstreamFetch: async (_url, options) => {
      forwarded = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: {
      messages: [
        { role: 'system', content: `INICIO-${'S'.repeat(450_000)}-FIM` },
        { role: 'user', content: 'ping' },
      ],
    },
  });
  assert.equal(response.status, 200);
  const system = forwarded.messages.find((message) => message.role === 'system');
  assert.match(system.content, /INICIO-/);
  assert.match(system.content, /FIM/);
  assert.equal(forwarded.messages.at(-1).content, 'ping');
  assert.ok(Math.ceil(JSON.stringify(forwarded.messages).length / 3) <= 130_000);
  assert.equal(system.content.includes('S'.repeat(450_000)), false);
});

test('COMPACTION_ENABLED false sends the long history unchanged', async (t) => {
  let forwarded;
  const calls = [];
  const app = await startControl(t, {
    compactionEnabled: false,
    geminiKey: GEMINI_KEY,
    upstreamFetch: async (url, options) => {
      calls.push(url);
      forwarded = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  const owner = await app.login();
  const messages = longContext();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [MINIMAX_URL]);
  assert.match(JSON.stringify(forwarded.messages), /MEIO-UNICO-0/);
  assert.match(JSON.stringify(forwarded.messages), /ULTIMA-MENSAGEM/);
});
