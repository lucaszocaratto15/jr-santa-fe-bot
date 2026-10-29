import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CdpBridgeHandle } from '@/process/resources/builtinMcp/cdpBridge';
import { createRecorder } from '@/process/services/teach/recording/recorder';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Sent = { method: string; params?: Record<string, unknown> };

const fakeBridge = (initialId: number | null = 7) => {
  const eventListeners = new Set<(method: string, params: unknown) => void>();
  const attachListeners = new Set<(id: number) => void>();
  let attachedId = initialId;
  const sent: Sent[] = [];
  const locks: boolean[] = [];
  let href = 'https://portal.example.com/login';
  const bridge = {
    port: 0,
    token: 't',
    attachedWebContentsId: () => attachedId,
    attach: () => ({ ok: true as const }),
    detach: () => {},
    close: async () => {},
    addSecret: () => {},
    sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: `s${sent.length}` };
      if (method === 'Runtime.evaluate' && params?.expression === 'location.href') {
        return { result: { value: href } };
      }
      return {};
    }),
    onEvent: (listener: (method: string, params: unknown) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onAttach: (listener: (id: number) => void) => {
      attachListeners.add(listener);
      return () => attachListeners.delete(listener);
    },
    setClientsLocked: (locked: boolean) => {
      locks.push(locked);
    },
  } satisfies CdpBridgeHandle;
  return {
    bridge,
    sent,
    locks,
    setHref: (next: string) => {
      href = next;
    },
    emit: (method: string, params: unknown) => {
      for (const listener of eventListeners) listener(method, params);
    },
    page: (payload: Record<string, unknown>) => {
      for (const listener of eventListeners) {
        listener('Runtime.bindingCalled', { name: '__jrTeachEvent', payload: JSON.stringify(payload) });
      }
    },
    attachNew: (id: number) => {
      attachedId = id;
      for (const listener of attachListeners) listener(id);
    },
    listenerCount: () => eventListeners.size + attachListeners.size,
  };
};

const setup = async (opts: { limitMs?: number; initialId?: number | null } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'jr-teach-'));
  roots.push(dir);
  const fake = fakeBridge(opts.initialId === undefined ? 7 : opts.initialId);
  const onAutoStop = vi.fn();
  let clock = 1_000;
  const recorder = createRecorder({
    bridge: fake.bridge,
    dir,
    now: () => clock,
    limitMs: opts.limitMs,
    onAutoStop,
  });
  return { dir, fake, recorder, onAutoStop, tick: (ms: number) => (clock += ms) };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('teach recorder', () => {
  it('injects the capture binding and script into the attached page on start', async () => {
    const { fake, recorder } = await setup();
    await recorder.start('emitir nota');
    const methods = fake.sent.map((s) => s.method);
    expect(methods).toContain('Runtime.addBinding');
    expect(fake.sent.find((s) => s.method === 'Runtime.addBinding')?.params).toEqual({ name: '__jrTeachEvent' });
    expect(methods).toContain('Page.addScriptToEvaluateOnNewDocument');
    const evaluated = fake.sent.filter((s) => s.method === 'Runtime.evaluate').map((s) => s.params?.expression);
    const source = fake.sent.find((s) => s.method === 'Page.addScriptToEvaluateOnNewDocument')?.params?.source;
    expect(evaluated).toContain(source);
    expect(recorder.state()).toBe('recording');
  });

  it('writes «segredo» instead of a password value', async () => {
    const { dir, fake, recorder } = await setup();
    const { id } = await recorder.start('login');
    const field = { tag: 'input', type: 'password', name: 'pass' };
    // Even if a (hostile or buggy) page sends a value for a secret field, main masks it.
    fake.page({ kind: 'input', url: 'https://portal.example.com/login', field, value: 'S3nh@', target: [] });
    fake.page({
      kind: 'input',
      url: 'https://portal.example.com/login',
      field: { tag: 'input', type: 'text', name: 'cpf' },
      secret: true,
      value: 'S3nh@',
    });
    fake.page({ kind: 'submit', url: 'https://portal.example.com/login', secret: true, target: [{ css: 'form' }] });
    const result = await recorder.stop();
    const text = await readFile(join(dir, id, 'events.jsonl'), 'utf8');
    expect(text).not.toContain('S3nh@');
    expect(JSON.stringify(result)).not.toContain('S3nh@');
    const inputs = result.events.filter((e) => e.kind === 'input');
    expect(inputs.map((e) => e.value)).toEqual(['«segredo»', '«segredo»']);
    expect(result.secretOrigins).toEqual(['https://portal.example.com']);
    expect(text.trim().split('\n')).toHaveLength(result.events.length);
  });

  it('records non-secret values truncated to 500 chars and never records paste', async () => {
    const { fake, recorder } = await setup();
    await recorder.start('x');
    fake.page({
      kind: 'input',
      url: 'https://a.test/',
      field: { tag: 'input', type: 'text', name: 'nf' },
      value: 'x'.repeat(600),
    });
    fake.page({ kind: 'paste', url: 'https://a.test/', value: 'clip' });
    fake.page({ kind: 'key', url: 'https://a.test/', key: 'Enter', target: [{ role: 'textbox', name: 'NF' }] });
    const { events } = await recorder.stop();
    expect(events.find((e) => e.kind === 'input')?.value).toHaveLength(500);
    expect(JSON.stringify(events)).not.toContain('clip');
    expect(events.find((e) => e.kind === 'key')).toMatchObject({
      key: 'Enter',
      tab: 1,
      target: [{ role: 'textbox', name: 'NF' }],
    });
  });

  it('records main-frame navigations only', async () => {
    const { fake, recorder } = await setup();
    await recorder.start('x');
    fake.emit('Page.frameNavigated', { frame: { id: 'f', url: 'https://a.test/home' } });
    fake.emit('Page.frameNavigated', { frame: { id: 'g', parentId: 'f', url: 'https://ads.test/' } });
    const { events } = await recorder.stop();
    expect(events.filter((e) => e.kind === 'navigate').map((e) => e.url)).toEqual([
      'https://portal.example.com/login',
      'https://a.test/home',
    ]);
  });

  it('ignores events while paused', async () => {
    const { fake, recorder } = await setup();
    await recorder.start('x');
    recorder.pause();
    expect(recorder.state()).toBe('paused');
    fake.page({ kind: 'click', url: 'https://a.test/', target: [{ text: 'Pausado' }] });
    recorder.resume();
    fake.page({ kind: 'click', url: 'https://a.test/', target: [{ text: 'Ativo' }] });
    const { events } = await recorder.stop();
    expect(JSON.stringify(events)).not.toContain('Pausado');
    expect(JSON.stringify(events)).toContain('Ativo');
  });

  it('locks bridge clients while recording and unlocks on stop', async () => {
    const { fake, recorder } = await setup();
    await recorder.start('x');
    expect(fake.locks).toEqual([true]);
    recorder.pause();
    expect(fake.locks.at(-1)).toBe(true);
    await recorder.stop();
    expect(fake.locks.at(-1)).toBe(false);
    expect(recorder.state()).toBe('idle');
    expect(fake.listenerCount()).toBe(0);
    expect(fake.sent.map((s) => s.method)).toContain('Runtime.removeBinding');
  });

  it('auto-stops at limitMs and calls onAutoStop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fake, recorder, onAutoStop } = await setup({ limitMs: 600_000 });
    await recorder.start('x');
    vi.advanceTimersByTime(599_999);
    expect(onAutoStop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(onAutoStop).toHaveBeenCalledTimes(1));
    expect(recorder.state()).toBe('idle');
    expect(fake.locks.at(-1)).toBe(false);
    // A later stop() returns the auto-stopped result instead of failing.
    const result = await recorder.stop();
    expect(result.events.length).toBeGreaterThan(0);
  });

  it('records tab-open when a new webContents attaches', async () => {
    const { fake, recorder } = await setup();
    await recorder.start('x');
    fake.setHref('https://nfe.example.com/popup');
    const before = fake.sent.length;
    fake.attachNew(9);
    await flush();
    await flush();
    fake.page({ kind: 'click', url: 'https://nfe.example.com/popup', target: [{ text: 'Baixar' }] });
    fake.attachNew(7);
    await flush();
    await flush();
    const { events } = await recorder.stop();
    expect(events.find((e) => e.kind === 'tab-open')).toMatchObject({ tab: 2, url: 'https://nfe.example.com/popup' });
    expect(events.find((e) => e.kind === 'click')).toMatchObject({ tab: 2 });
    expect(events.find((e) => e.kind === 'tab-switch')).toMatchObject({ tab: 1 });
    const reinjected = fake.sent.slice(before).map((s) => s.method);
    expect(reinjected).toContain('Runtime.addBinding');
    expect(reinjected).toContain('Page.addScriptToEvaluateOnNewDocument');
  });

  it('records downloads only while recording', async () => {
    const { fake, recorder } = await setup();
    recorder.recordDownload({ fileName: 'antes.pdf', origin: 'https://a.test' });
    await recorder.start('x');
    recorder.recordDownload({ fileName: 'nota.pdf', origin: 'https://nfe.example.com' });
    const { events } = await recorder.stop();
    expect(fake.sent.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.kind === 'download')).toEqual([
      expect.objectContaining({ fileName: 'nota.pdf', url: 'https://nfe.example.com/', tab: 1 }),
    ]);
  });

  it('discard removes the recording dir', async () => {
    const { dir, fake, recorder } = await setup();
    const { id } = await recorder.start('x');
    fake.page({ kind: 'click', url: 'https://a.test/', target: [{ text: 'Ok' }] });
    await flush();
    await expect(stat(join(dir, id))).resolves.toBeTruthy();
    await recorder.discard();
    await expect(stat(join(dir, id))).rejects.toThrow();
    expect(recorder.state()).toBe('idle');
    expect(fake.locks.at(-1)).toBe(false);
  });

  it('cleanup removes a saved recording dir and rejects path traversal', async () => {
    const { dir, recorder } = await setup();
    const { id } = await recorder.start('x');
    await recorder.stop();
    await recorder.cleanup(id);
    await expect(stat(join(dir, id))).rejects.toThrow();
    await expect(recorder.cleanup('../etc')).rejects.toThrow();
  });

  it('never writes secret url parameters to events.jsonl', async () => {
    const { dir, fake, recorder } = await setup();
    fake.setHref('https://p.gov.br/login?user=x&pw=S3nh@');
    const { id } = await recorder.start('x');
    fake.emit('Page.frameNavigated', { frame: { id: 'f', url: 'https://p.gov.br/cb#access_token=abc123' } });
    fake.page({ kind: 'click', url: 'https://p.gov.br/login?user=x&pw=S3nh@', target: [{ text: 'Entrar' }] });
    fake.page({ kind: 'input', url: 'https://p.gov.br/login?pw=S3nh@', field: { tag: 'input', type: 'password' } });
    fake.setHref('https://p.gov.br/popup?token=abc123');
    fake.attachNew(9);
    await flush();
    await flush();
    const result = await recorder.stop();
    const text = await readFile(join(dir, id, 'events.jsonl'), 'utf8');
    for (const leak of ['S3nh@', 'abc123']) {
      expect(text).not.toContain(leak);
      expect(JSON.stringify(result)).not.toContain(leak);
    }
    expect(result.events[0].url).toBe('https://p.gov.br/login?user=x&pw=«segredo»');
    expect(result.secretOrigins).toEqual(['https://p.gov.br']);
  });

  it('records a tab attached while paused when recording resumes', async () => {
    const { fake, recorder } = await setup();
    await recorder.start('x');
    recorder.pause();
    fake.setHref('https://nfe.example.com/popup');
    fake.attachNew(9);
    await flush();
    await flush();
    recorder.resume();
    fake.page({ kind: 'click', url: 'https://nfe.example.com/popup', target: [{ text: 'Baixar' }] });
    const { events } = await recorder.stop();
    expect(events.slice(-2).map((e) => [e.kind, e.tab])).toEqual([
      ['tab-open', 2],
      ['click', 2],
    ]);
  });

  it('discard during an in-flight auto-stop removes the dir and stop returns the same result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { dir, fake, recorder, onAutoStop } = await setup({ limitMs: 1_000 });
    const { id } = await recorder.start('x');
    fake.page({ kind: 'click', url: 'https://a.test/', target: [{ text: 'Ok' }] });
    vi.advanceTimersByTime(1_000);
    vi.useRealTimers();
    const stopped = recorder.stop();
    await recorder.discard();
    await expect(stopped).resolves.toMatchObject({ id });
    await expect(stat(join(dir, id))).rejects.toThrow();
    await vi.waitFor(() => expect(onAutoStop).toHaveBeenCalledTimes(1));
    expect(recorder.state()).toBe('idle');
  });

  it('refuses to start twice', async () => {
    const { recorder } = await setup();
    await recorder.start('x');
    await expect(recorder.start('y')).rejects.toThrow();
  });
});
