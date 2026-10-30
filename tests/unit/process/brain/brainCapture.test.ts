import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@process/services/teach/lessons/lessonRuntime', () => ({ vaultSecrets: async () => [] }));

import { createBrainCapture, MAX_QUEUE_ITEMS } from '@process/services/brain/brainCapture';
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
