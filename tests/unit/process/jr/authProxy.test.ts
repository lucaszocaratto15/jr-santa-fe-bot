import { afterEach, expect, it, vi } from 'vitest';
import { startJrAuthProxy } from '@/process/services/jr/authProxy';

const secret = 'remote-session-'.repeat(4);
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

it('keeps remote sessions in native memory while forwarding only allowed model routes', async () => {
  const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${secret}`);
    return Response.json({ data: [{ id: 'MiniMax-M3.1-Flash' }] });
  });
  const proxy = await startJrAuthProxy(
    { url: 'https://company.example/bot/v1', token: secret, model: 'MiniMax-M3.1-Flash' },
    () => {},
    request
  );
  closers.push(proxy.close);
  expect(JSON.stringify(proxy.connection)).not.toContain(secret);
  const response = await fetch(`${proxy.connection.url}/models`, {
    headers: { Authorization: `Bearer ${proxy.connection.token}` },
  });
  expect(response.status).toBe(200);
  expect(request.mock.calls[0][0]).toBe('https://company.example/bot/v1/models');
  expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
});

it('rejects missing or forged local capabilities before any remote request', async () => {
  const request = vi.fn();
  const proxy = await startJrAuthProxy(
    { url: 'https://company.example/bot/v1', token: secret, model: 'MiniMax-M3.1-Flash' },
    () => {},
    request
  );
  closers.push(proxy.close);
  const response = await fetch(`${proxy.connection.url}/models`, { headers: { Authorization: 'Bearer forged-token' } });
  expect(response.status).toBe(401);
  expect(request).not.toHaveBeenCalled();
});

it('does not expose control or arbitrary routes through the renderer-visible capability', async () => {
  const request = vi.fn();
  const proxy = await startJrAuthProxy(
    { url: 'https://company.example/bot/v1', token: secret, model: 'MiniMax-M3.1-Flash' },
    () => {},
    request
  );
  closers.push(proxy.close);
  for (const suffix of ['/admin/employees', '/models?leak=true', '/chat/completions/other']) {
    const response = await fetch(`${proxy.connection.url}${suffix}`, {
      headers: { Authorization: `Bearer ${proxy.connection.token}` },
    });
    expect(response.status).toBe(404);
  }
  expect(request).not.toHaveBeenCalled();
});

it('notifies a blocked employee from the gateway response and hides the upstream body', async () => {
  const denied = vi.fn();
  const request = vi.fn(
    async () => new Response(JSON.stringify({ error: { code: 'employee_blocked' } }), { status: 403 })
  );
  const proxy = await startJrAuthProxy(
    { url: 'https://company.example/bot/v1', token: secret, model: 'MiniMax-M3.1-Flash' },
    denied,
    request
  );
  closers.push(proxy.close);
  const response = await fetch(`${proxy.connection.url}/models`, {
    headers: { Authorization: `Bearer ${proxy.connection.token}` },
  });
  expect(response.status).toBe(403);
  expect(await response.text()).toBe('');
  expect(denied).toHaveBeenCalledWith({ status: 403, code: 'employee_blocked' });
});

it('keeps an ordinary upstream failure local and does not clear the session', async () => {
  const denied = vi.fn();
  const request = vi.fn(async () => new Response('upstream failed', { status: 500 }));
  const proxy = await startJrAuthProxy(
    { url: 'https://company.example/bot/v1', token: secret, model: 'MiniMax-M3.1-Flash' },
    denied,
    request
  );
  closers.push(proxy.close);
  const response = await fetch(`${proxy.connection.url}/models`, {
    headers: { Authorization: `Bearer ${proxy.connection.token}` },
  });
  expect(response.status).toBe(502);
  expect(denied).not.toHaveBeenCalled();
});

it('notifies revocation on upstream 401 and never returns its response body', async () => {
  const revoked = vi.fn();
  const request = vi.fn(async () => new Response(`server leaked ${secret}`, { status: 401 }));
  const proxy = await startJrAuthProxy(
    { url: 'https://company.example/bot/v1', token: secret, model: 'MiniMax-M3.1-Flash' },
    revoked,
    request
  );
  closers.push(proxy.close);
  const response = await fetch(`${proxy.connection.url}/models`, {
    headers: { Authorization: `Bearer ${proxy.connection.token}` },
  });
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain(secret);
  expect(revoked).toHaveBeenCalledOnce();
});

it('streams successful model replies and strips upstream headers', async () => {
  const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'MiniMax-M3.1-Flash' });
    return new Response('data: {"choices":[{"delta":{"content":"Olá"}}]}\n\ndata: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream', 'x-sensitive': secret },
    });
  });
  const proxy = await startJrAuthProxy(
    { url: 'https://company.example/bot/v1', token: secret, model: 'MiniMax-M3.1-Flash' },
    () => {},
    request
  );
  closers.push(proxy.close);
  const response = await fetch(`${proxy.connection.url}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${proxy.connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'MiniMax-M3.1-Flash', messages: [{ role: 'user', content: 'Olá' }], stream: true }),
  });
  expect(await response.text()).toContain('Olá');
  expect(response.headers.get('x-sensitive')).toBeNull();
});
