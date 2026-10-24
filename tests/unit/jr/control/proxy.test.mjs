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
  assert.deepEqual(forwarded.messages[1], messages[1]);
});

const OPENROUTER_KEY = 'openrouter-test-key-not-real';
const OPENCODE_KEY = 'opencode-test-key-not-real-xx';
const GEMINI_KEY = 'gemini-test-key-not-real-xx';
const MINIMAX_URL = 'https://jrsantafe.stratacerta.com.br/mmx/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENCODE_URL = 'https://opencode.ai/inference/openai/v1/chat/completions';
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
      'gemini-2.5-flash',
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

test('provider 400 and a missing fallback key stay on the public MiniMax error', async (t) => {
  let calls = 0;
  const app = await startControl(t, {
    openRouterModels: 'deepseek/deepseek-chat:free',
    upstreamFetch: async () => {
      calls += 1;
      return new Response('bad request', { status: 400 });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(response.status, 502);
  assert.equal(calls, 1);
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

test('a failed OpenRouter call is replayed on the next free OpenCode model', async (t) => {
  const logs = [];
  const calls = [];
  const app = await startControl(t, {
    log: (line) => logs.push(line),
    openRouterKey: OPENROUTER_KEY,
    openRouterModels: 'deepseek/deepseek-chat:free',
    openCodeKey: OPENCODE_KEY,
    openCodeModels: 'big-pickle,glm-5.3-flash-free',
    geminiKey: GEMINI_KEY,
    upstreamFetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, model: body.model, authorization: options.headers.Authorization });
      if (url === MINIMAX_URL) return new Response('down', { status: 503 });
      if (url === OPENROUTER_URL) return new Response('busy', { status: 429 });
      if (body.model === 'big-pickle') return new Response('opencode down', { status: 503 });
      assert.equal(options.headers.Authorization, `Bearer ${OPENCODE_KEY}`);
      return Response.json({
        choices: [{ message: { content: 'livre' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
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
  assert.equal(response.headers.get('x-jr-provider'), 'opencode');
  assert.equal((await response.json()).choices[0].message.content, 'livre');
  assert.deepEqual(
    calls.map((call) => call.model),
    ['MiniMax-M3.1-Flash', 'openrouter/free', 'deepseek/deepseek-chat:free', 'big-pickle', 'glm-5.3-flash-free']
  );
  assert.equal(calls.at(-1).url, OPENCODE_URL);
  assert.equal(
    calls.some((call) => call.url === GEMINI_URL),
    false
  );
  assert.deepEqual(logs, ['Provedor: opencode glm-5.3-flash-free']);
  assert.equal(logs.join('\n').includes(OPENCODE_KEY), false);
});

test('a failed OpenCode call continues to Gemini', async (t) => {
  const logs = [];
  const calls = [];
  const app = await startControl(t, {
    log: (line) => logs.push(line),
    openCodeKey: OPENCODE_KEY,
    openCodeModels: 'beam-free,flint-40b-free',
    geminiKey: GEMINI_KEY,
    upstreamFetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, model: body.model });
      if (url === OPENCODE_URL) return new Response(`limit ${OPENCODE_KEY}`, { status: 429 });
      if (url === MINIMAX_URL) throw new Error('network down');
      assert.equal(options.headers.Authorization, `Bearer ${GEMINI_KEY}`);
      return Response.json({ choices: [{ message: { content: 'gemini' } }] });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-jr-provider'), 'gemini');
  assert.equal((await response.text()).includes(OPENCODE_KEY), false);
  assert.deepEqual(
    calls.map((call) => call.model),
    ['MiniMax-M3.1-Flash', 'beam-free', 'flint-40b-free', 'gemini-2.5-flash']
  );
  assert.equal(logs.join('\n').includes(OPENCODE_KEY), false);
});

test('a missing OpenCode key skips that provider', async (t) => {
  const calls = [];
  const app = await startControl(t, {
    log: () => {},
    openRouterKey: OPENROUTER_KEY,
    openCodeModels: 'big-pickle,minimax-m3',
    geminiKey: GEMINI_KEY,
    upstreamFetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, model: body.model });
      if (url === GEMINI_URL) return Response.json({ choices: [{ message: { content: 'gemini' } }] });
      return new Response('down', { status: 429 });
    },
  });
  const owner = await app.login();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    token: owner.token,
    body: { messages: [{ role: 'user', content: 'Olá' }] },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-jr-provider'), 'gemini');
  assert.equal(
    calls.some((call) => call.url === OPENCODE_URL || call.model === 'minimax-m3'),
    false
  );
});
