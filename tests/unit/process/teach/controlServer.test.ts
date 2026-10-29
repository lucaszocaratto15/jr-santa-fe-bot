import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTeachControlServer, type TeachHandlers } from '@/process/services/teach/controlServer';

type Server = Awaited<ReturnType<typeof createTeachControlServer>>;

const makeHandlers = (): TeachHandlers => ({
  vault_list: vi.fn(async () => ({ items: [] })),
  vault_fill: vi.fn(async (body: unknown) => ({ ok: true, echoed: body })),
  secure_input: vi.fn(async () => ({ ok: true, result: 'enviado' })),
  secure_input_status: vi.fn(async () => ({ ok: true, result: 'cancelado' })),
  teach_submit_draft: vi.fn(async () => ({ ok: true, result: 'cartão de revisão exibido' })),
});

describe('teach control server', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  const post = (path: string, body: string, token?: string) =>
    fetch(`http://127.0.0.1:${server!.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-jr-teach-token': token } : {}) },
      body,
    });

  it('rejects requests without a token with 403', async () => {
    server = await createTeachControlServer(makeHandlers());
    expect((await post('/vault_list', '{}')).status).toBe(403);
  });

  it('rejects a wrong token with 403', async () => {
    server = await createTeachControlServer(makeHandlers());
    expect((await post('/vault_list', '{}', 'x'.repeat(server.token.length))).status).toBe(403);
  });

  it('returns 404 for an unknown tool', async () => {
    server = await createTeachControlServer(makeHandlers());
    expect((await post('/nope', '{}', server.token)).status).toBe(404);
  });

  it('returns 400 for non-JSON bodies and bodies over 256 KB', async () => {
    server = await createTeachControlServer(makeHandlers());
    expect((await post('/vault_list', 'not json', server.token)).status).toBe(400);
    const big = JSON.stringify({ markdown: 'a'.repeat(300 * 1024) });
    expect((await post('/teach_submit_draft', big, server.token)).status).toBe(400);
  });

  it('routes to the handler with the parsed body', async () => {
    const handlers = makeHandlers();
    server = await createTeachControlServer(handlers);
    const res = await post('/vault_fill', JSON.stringify({ item: 'a', field: 'password' }), server.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, echoed: { item: 'a', field: 'password' } });
    expect(handlers.vault_fill).toHaveBeenCalledWith({ item: 'a', field: 'password' });
  });

  it('returns a generic error when a handler throws, without leaking the message', async () => {
    const handlers = makeHandlers();
    handlers.vault_list = async () => {
      throw new Error('secret-detail');
    };
    server = await createTeachControlServer(handlers);
    const res = await post('/vault_list', '{}', server.token);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret-detail');
  });

  it('listens on 127.0.0.1 only', async () => {
    server = await createTeachControlServer(makeHandlers());
    expect(server.host).toBe('127.0.0.1');
  });
});
