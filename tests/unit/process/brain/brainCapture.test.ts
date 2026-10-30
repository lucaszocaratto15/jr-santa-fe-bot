import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@process/services/teach/lessons/lessonRuntime', () => ({ vaultSecrets: async () => [] }));

import { createBrainCapture, MAX_PAYLOAD_BYTES, MAX_QUEUE_ITEMS } from '@process/services/brain/brainCapture';
import { createBrainService } from '@process/services/brain/brainIpc';
import type { BrainCapturePayload } from '@/common/types/agent/brainTypes';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jr-brain-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const input = (id: string, text = 'a resposta da obra de Jales ficou combinada') => ({
  conversationId: 'c1',
  messages: [
    { id: `u${id}`, role: 'user' as const, text: 'qual o prazo?' },
    { id: `a${id}`, role: 'assistant' as const, text },
  ],
});

const make = (send: (p: BrainCapturePayload) => Promise<void>, secrets: string[] = [], now = () => 0) => {
  const timers: Array<() => void> = [];
  const capture = createBrainCapture({
    dir,
    send,
    secrets: async () => secrets,
    now,
    schedule: (run) => timers.push(run),
  });
  return { capture, timers };
};

describe('brainCapture', () => {
  it('sends without any acknowledgement and marks the stretch as captured', async () => {
    const send = vi.fn(async () => {});
    const { capture } = make(send);
    await capture.submit(input('1'));
    await capture.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(send.mock.calls[0][0].conversationRef).not.toContain('c1');
    expect(await capture.lastCaptured('c1')).toBe('a1');
    expect(await capture.pending()).toBe(0);
  });

  it('redacts vault secrets before the text is queued or sent', async () => {
    const send = vi.fn(async () => {});
    const { capture } = make(send, ['s3nh4-Secreta-99']);
    await capture.submit(input('1', 'a senha é s3nh4-Secreta-99 ok'));
    await capture.flush();
    const sent = JSON.stringify(send.mock.calls[0][0]);
    expect(sent).not.toContain('s3nh4-Secreta-99');
    const onDisk = await readFile(join(dir, 'queue.json'), 'utf8');
    expect(onDisk).not.toContain('s3nh4-Secreta-99');
  });

  it('keeps the item queued on 503, resolves for the caller and retries after the backoff', async () => {
    let clock = 1000;
    const send = vi.fn<(p: BrainCapturePayload) => Promise<void>>().mockRejectedValueOnce(new Error('503'));
    send.mockResolvedValue(undefined);
    const { capture, timers } = make(send, [], () => clock);
    await expect(capture.submit(input('1'))).resolves.toBeUndefined();
    await capture.flush();
    expect(await capture.pending()).toBe(1);
    expect(timers).toHaveLength(1);
    // Too early: still backing off.
    await capture.flush();
    expect(send).toHaveBeenCalledTimes(1);
    clock += 60_000;
    await capture.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(await capture.pending()).toBe(0);
  });

  it('persists the queue across a restart', async () => {
    const down = vi.fn(async () => {
      throw new Error('offline');
    });
    const first = make(down);
    await first.capture.submit(input('1'));
    await first.capture.flush();
    const up = vi.fn(async () => {});
    const second = make(up);
    expect(await second.capture.pending()).toBe(1);
    expect(await second.capture.lastCaptured('c1')).toBe('a1');
    await second.capture.flush();
    expect(up).toHaveBeenCalledTimes(1);
  });

  it('caps the queue at 200 items and drops the oldest', async () => {
    const send = vi.fn(async () => {
      throw new Error('offline');
    });
    const { capture } = make(send);
    for (let i = 0; i < MAX_QUEUE_ITEMS + 5; i += 1) await capture.submit(input(String(i), `resposta número ${i}`));
    expect(await capture.pending()).toBe(MAX_QUEUE_ITEMS);
    const items = JSON.parse(await readFile(join(dir, 'queue.json'), 'utf8')).items as Array<{
      payload: BrainCapturePayload;
    }>;
    expect(items[0].payload.messages[1].text).toBe('resposta número 5');
  });

  it('starts empty when the queue file is corrupt', async () => {
    await writeFile(join(dir, 'queue.json'), '{not json');
    const { capture } = make(vi.fn(async () => {}));
    expect(await capture.pending()).toBe(0);
  });
});

describe('brain service notice', () => {
  const service = (consent: () => Promise<unknown>) =>
    createBrainService({
      dir,
      secrets: async () => [],
      client: {
        capture: async () => {},
        consent: consent as never,
        consentState: async () => ({ version: null, at: null }),
        search: async () => [],
        feedback: async () => ({ suspended: false }),
        me: async () => ({ areas: [], isDirector: false, manages: [] }),
        manage: {},
      },
    });

  it('starts unacknowledged, records 1.4 locally and survives a server failure', async () => {
    const consent = vi.fn(async () => {
      throw new Error('offline');
    });
    const s = service(consent);
    expect((await s.consentState()).current).toBe(false);
    const state = await s.accept('1.4');
    expect(state).toMatchObject({ acknowledgedVersion: '1.4', current: true });
    expect((await service(consent).consentState()).current).toBe(true);
    // Resent when the server is back.
    consent.mockResolvedValueOnce({ version: '1.4', at: 'x' });
    await s.resume();
    expect(consent).toHaveBeenCalledTimes(2);
    await s.resume();
    expect(consent).toHaveBeenCalledTimes(2);
  });

  it('treats another acknowledged version as not current', async () => {
    const s = service(async () => ({ version: '1.3', at: 'x' }));
    await s.accept('1.3');
    expect((await s.consentState()).current).toBe(false);
  });
});

describe('brainCapture fix round 1', () => {
  const SECRET = 'Zq9-Secret-Value-XYZ';
  const run = async (messages: Array<{ id: string; role: 'user' | 'assistant' | 'tool'; text: string }>) => {
    const send = vi.fn(async (_p: BrainCapturePayload) => {});
    const { capture } = make(send, [SECRET]);
    await capture.submit({ conversationId: 'c1', messages });
    await capture.flush();
    return send.mock.calls[0][0];
  };

  it('redacts a vault secret inside a tool message', async () => {
    const sent = await run([
      { id: 'a', role: 'assistant', text: 'ok' },
      { id: 't', role: 'tool', text: `página: ${SECRET} fim` },
    ]);
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  it('never leaves a prefix of a secret that straddles the old cut points', async () => {
    for (const [role, cut] of [
      ['tool', 500],
      ['user', 4000],
    ] as const) {
      for (let offset = 1; offset < SECRET.length; offset += 3) {
        const text = 'x'.repeat(cut - offset) + SECRET + ' resto';
        const sent = await run([
          { id: 'a', role: 'assistant', text: 'ok' },
          { id: 'm', role, text },
        ]);
        const out = sent.messages.at(-1)?.text ?? '';
        expect(out).not.toContain(SECRET.slice(0, 6));
        expect(out.length).toBeLessThanOrEqual(cut);
      }
    }
  });

  it('drops a permanently rejected head item (400) and sends the next', async () => {
    const send = vi
      .fn<(p: BrainCapturePayload) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('JR_ACCESS_UNAVAILABLE'), { status: 400 }));
    send.mockResolvedValue(undefined);
    const { capture } = make(send, [], () => 0);
    // First submit flushes (and is dropped) on its own; queue a second one afterwards.
    await capture.submit(input('1'));
    await capture.flush();
    await capture.submit({ ...input('2'), conversationId: 'c2' });
    await capture.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(await capture.pending()).toBe(0);
  });

  it('drops the 400 head within one pass and continues to the next item', async () => {
    const down = vi.fn(async () => {
      throw new Error('offline');
    });
    const first = make(down);
    await first.capture.submit(input('1'));
    await first.capture.submit({ ...input('2'), conversationId: 'c2' });
    const send = vi
      .fn<(p: BrainCapturePayload) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { status: 400 }));
    send.mockResolvedValue(undefined);
    const second = make(send, [], () => 10_000_000);
    await second.capture.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(await second.capture.pending()).toBe(0);
  });

  it.each([401, 408, 429, 500, 503])('keeps the item on a transient %i', async (status) => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('x'), { status });
    });
    const { capture } = make(send);
    await capture.submit(input('1'));
    await capture.flush();
    expect(await capture.pending()).toBe(1);
  });

  it('trims an oversized stretch under the payload cap, oldest messages first', async () => {
    const big = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      text: `${i}-`.padEnd(4000, 'z'),
    }));
    const sent = await run(big);
    expect(JSON.stringify(sent).length).toBeLessThan(MAX_PAYLOAD_BYTES + 1000);
    expect(JSON.stringify(sent.messages).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(sent.messages.at(-1)?.text.startsWith('59-')).toBe(true);
    expect(sent.messages.length).toBeLessThan(60);
  });

  it('empties the queue when another profile logs in', async () => {
    const down = vi.fn(async () => {
      throw new Error('offline');
    });
    const a = make(down);
    await a.capture.bindProfile('ana');
    await a.capture.submit(input('1'));
    await a.capture.flush();
    expect(await a.capture.pending()).toBe(1);
    const b = make(vi.fn(async () => {}));
    await b.capture.bindProfile('ana');
    expect(await b.capture.pending()).toBe(1);
    await b.capture.bindProfile('bia');
    expect(await b.capture.pending()).toBe(0);
    expect(await b.capture.lastCaptured('c1')).toBeNull();
  });

  it('counts bytes of the whole serialized payload, multibyte text included', async () => {
    const accented = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      text: `${i}-`.padEnd(3500, 'ação 😀 ').slice(0, 3500),
    }));
    const sent = await run(accented);
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(sent.messages.at(-1)?.text.startsWith('59-')).toBe(true);
    expect(sent.messages.length).toBeLessThan(60);
  });

  it('treats 409 as permanent', async () => {
    const send = vi
      .fn<(p: BrainCapturePayload) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('JR_ACCESS_EMPLOYEE_REVOKED'), {}));
    send.mockResolvedValue(undefined);
    const { capture } = make(send);
    await capture.submit(input('1'));
    await capture.flush();
    expect(await capture.pending()).toBe(0);
  });

  it('clears a queue without profile.json on the first bind and sends nothing before it', async () => {
    const down = vi.fn(async () => {
      throw new Error('offline');
    });
    const old = make(down);
    await old.capture.submit(input('1'));
    expect(await old.capture.pending()).toBe(1);
    const send = vi.fn(async () => {});
    const gated = createBrainCapture({ dir, send, secrets: async () => [], requireBoundProfile: true });
    await gated.submit(input('2'));
    await gated.flush();
    expect(send).not.toHaveBeenCalled();
    await gated.bindProfile('ana');
    expect(await gated.pending()).toBe(0);
    await gated.submit(input('3'));
    await gated.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
