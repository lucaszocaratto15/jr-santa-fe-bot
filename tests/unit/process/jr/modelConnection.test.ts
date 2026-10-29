import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatCompletion,
  getJrModelConnection,
  setJrModelConnection,
} from '@/process/services/jr/modelConnection';

const connection = { url: 'http://127.0.0.1:4321/v1', token: 'cap-token', model: 'MiniMax-M2' };
const messages = [
  { role: 'system' as const, content: 'sys' },
  { role: 'user' as const, content: 'hi' },
];

afterEach(() => {
  setJrModelConnection(null);
  vi.unstubAllEnvs();
});

describe('chatCompletion', () => {
  it('posts to <url>/chat/completions with the connection model and token', async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          headers: { 'Content-Type': 'application/json' },
        })
    );
    expect(await chatCompletion(connection, messages, { request })).toBe('ok');
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4321/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cap-token');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'MiniMax-M2', stream: false, messages });
  });

  it('joins SSE deltas when the proxy streams', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Ol"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"á"}}]}',
      '',
      'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":3}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const request = vi.fn(async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }));
    expect(await chatCompletion(connection, messages, { request })).toBe('Olá');
  });

  it('maps a non-2xx answer to model_error', async () => {
    const request = vi.fn(async () => new Response('bad', { status: 502 }));
    await expect(chatCompletion(connection, messages, { request })).rejects.toThrow('model_error');
  });

  it('maps a network failure to offline', async () => {
    const request = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(chatCompletion(connection, messages, { request })).rejects.toThrow('offline');
  });

  it('a reply without content is a model_error', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ choices: [] })));
    await expect(chatCompletion(connection, messages, { request })).rejects.toThrow('model_error');
  });
});

describe('getJrModelConnection', () => {
  it('returns the registered proxy connection', () => {
    setJrModelConnection(connection);
    expect(getJrModelConnection()).toEqual(connection);
  });

  it('falls back to getJrRelayConfig when nothing was set', () => {
    vi.stubEnv('JR_LOCAL_PILOT', '1');
    vi.stubEnv('JR_RELAY_URL', 'http://127.0.0.1:9999/v1');
    vi.stubEnv('JR_RELAY_TOKEN', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    vi.stubEnv('JR_MINIMAX_MODEL', 'MiniMax-M2');
    expect(getJrModelConnection()).toEqual({
      url: 'http://127.0.0.1:9999/v1',
      token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      model: 'MiniMax-M2',
    });
  });

  it('is null with no proxy and no pilot relay', () => {
    vi.stubEnv('JR_LOCAL_PILOT', '');
    expect(getJrModelConnection()).toBeNull();
  });
});
