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
