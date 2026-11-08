import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

class FakeContents extends EventEmitter {
  id = 7;
  destroyed = false;
  sent: Array<{ method: string; params: unknown }> = [];
  commandResult: unknown = {};
  /** Value the internal secret-in-field probe returns (R13). */
  probeValue: unknown = false;
  /** When set, the probe call never settles (R16 timeout). */
  probeHangs = false;
  /** Internal probe calls (Runtime.callFunctionOn params) the bridge sent to the page. */
  probes: Array<{ functionDeclaration: string; arguments: Array<{ value?: unknown }> }> = [];
  /** Every internal (non-relayed) command the probe issued, for source inspection. */
  internal: Array<{ method: string; params: unknown }> = [];
  dbgEmitter = new EventEmitter();
  attachedFlag = false;
  debugger = {
    isAttached: () => this.attachedFlag,
    attach: () => {
      this.attachedFlag = true;
    },
    detach: () => {
      this.attachedFlag = false;
    },
    on: (e: string, l: (...a: unknown[]) => void) => this.dbgEmitter.on(e, l),
    removeListener: (e: string, l: (...a: unknown[]) => void) => this.dbgEmitter.removeListener(e, l),
    sendCommand: async (method: string, params: unknown) => {
      const p = (params ?? {}) as { expression?: string; functionDeclaration?: string; objectGroup?: string };
      if (p.objectGroup === 'jrTeachSecretProbe' || method === 'Runtime.releaseObjectGroup') {
        this.internal.push({ method, params });
        if (method === 'Runtime.evaluate') return { result: { type: 'object', objectId: 'global-1' } };
        if (method === 'Runtime.callFunctionOn') {
          this.probes.push(params as (typeof this.probes)[number]);
          if (this.probeHangs) return new Promise(() => {});
          return { result: { type: 'boolean', value: this.probeValue } };
        }
        return {};
      }
      this.sent.push({ method, params });
      return this.commandResult;
    },
  };
  getType = () => 'webview';
  isDestroyed = () => this.destroyed;
  getTitle = () => 't';
  getURL = () => 'https://x.test/';
  emitDbg(method: string, params: unknown) {
    this.dbgEmitter.emit('message', {}, method, params, '');
  }
  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

let contents: FakeContents;
vi.mock('electron', () => ({ webContents: { fromId: (id: number) => (id === contents?.id ? contents : null) } }));

const SECRET = 'S3nh@Forte9';

type Handle = Awaited<ReturnType<(typeof import('@process/resources/builtinMcp/cdpBridge'))['startCdpBridge']>>;

describe('cdpBridge redaction + internal api', () => {
  let handle: Handle;
  let ws: WebSocket;
  let frames: Array<Record<string, any>>;

  const waitFor = async (pred: () => boolean) => {
    for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(pred()).toBe(true);
  };
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = Math.floor(Math.random() * 1e9);
    ws.send(JSON.stringify({ id, method, params }));
    await waitFor(() => frames.some((f) => f.id === id));
    return frames.find((f) => f.id === id)!;
  };

  beforeEach(async () => {
    vi.resetModules();
    contents = new FakeContents();
    const mod = await import('@process/resources/builtinMcp/cdpBridge');
    handle = await mod.startCdpBridge();
    expect(handle.attach(contents.id)).toEqual({ ok: true });
    frames = [];
    ws = new WebSocket(`ws://127.0.0.1:${handle.port}/aionui-cdp?token=${handle.token}`);
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once('open', r));
  });

  afterEach(async () => {
    ws.close();
    await handle.close();
  });

  it('redacts secrets in relayed events', async () => {
    handle.addSecret(contents.id, SECRET);
    contents.emitDbg('Runtime.consoleAPICalled', { args: [{ value: SECRET }] });
    await waitFor(() => frames.some((f) => f.method === 'Runtime.consoleAPICalled'));
    const f = frames.find((x) => x.method === 'Runtime.consoleAPICalled')!;
    expect(JSON.stringify(f)).not.toContain(SECRET);
    expect(f.params.args[0].value).toBe('«segredo»');
  });

  it('hasLiveSecret reports a registered secret only for its webContents', () => {
    expect(handle.hasLiveSecret(contents.id)).toBe(false);
    handle.addSecret(contents.id, SECRET);
    expect(handle.hasLiveSecret(contents.id)).toBe(true);
    expect(handle.hasLiveSecret(contents.id + 1000)).toBe(false);
  });

  it('redacts forwarded command results', async () => {
    handle.addSecret(contents.id, SECRET);
    contents.commandResult = { result: { value: `pw=${SECRET}` } };
    const r = await call('Runtime.evaluate', { expression: '1' });
    expect(r.result.result.value).toBe('pw=«segredo»');
  });

  it('delivers __jrTeach bindings to onEvent only', async () => {
    const seen: string[] = [];
    handle.onEvent((m) => seen.push(m));
    contents.emitDbg('Runtime.bindingCalled', { name: '__jrTeachEvent', payload: 'x' });
    contents.emitDbg('Runtime.bindingCalled', { name: 'other', payload: 'y' });
    await waitFor(() => frames.some((f) => f.params?.name === 'other'));
    expect(seen).toEqual(['Runtime.bindingCalled', 'Runtime.bindingCalled']);
    expect(frames.some((f) => f.params?.name === '__jrTeachEvent')).toBe(false);
  });

  it('replies with a lock error and does not forward', async () => {
    handle.setClientsLocked(true, 'gravando');
    const r = await call('Runtime.evaluate');
    expect(r.error).toEqual({ code: -32000, message: 'browser locked: gravando' });
    expect(contents.sent.length).toBe(0);
    handle.setClientsLocked(false);
    const ok = await call('Runtime.evaluate');
    expect(ok.error).toBeUndefined();
  });

  it('strips postData and refuses getRequestPostData while a secret is live', async () => {
    contents.emitDbg('Network.requestWillBeSent', { request: { url: 'u', postData: 'before' } });
    await waitFor(() => frames.some((f) => f.method === 'Network.requestWillBeSent'));
    expect(frames[0].params.request.postData).toBe('before');

    handle.addSecret(contents.id, SECRET);
    contents.emitDbg('Network.requestWillBeSent', {
      request: { url: 'u2', postData: `pw=${SECRET}`, postDataEntries: [{ bytes: 'eA==' }] },
    });
    await waitFor(() => frames.filter((f) => f.method === 'Network.requestWillBeSent').length === 2);
    expect(frames[1].params.request).toEqual({ url: 'u2' });

    const r = await call('Network.getRequestPostData', { requestId: '1' });
    expect(r.error).toEqual({ code: -32000, message: 'post data hidden: vault secret on this page' });
    expect(contents.sent.length).toBe(0);
  });

  it('strips postData while locked even without a vault secret', async () => {
    handle.setClientsLocked(true, 'gravando');
    contents.emitDbg('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'u', postData: 'user=x&pw=S3nh@', postDataEntries: [{ bytes: 'eA==' }] },
    });
    await waitFor(() => frames.some((f) => f.method === 'Network.requestWillBeSent'));
    const f = frames.find((x) => x.method === 'Network.requestWillBeSent')!;
    expect(f.params.request).toEqual({ url: 'u' });
    expect(JSON.stringify(frames)).not.toContain('S3nh@');
  });

  it('refuses getRequestPostData after unlock for requests seen while locked', async () => {
    handle.setClientsLocked(true, 'gravando');
    contents.emitDbg('Network.requestWillBeSent', {
      requestId: 'r-locked',
      request: { url: 'u', postData: 'pw=S3nh@' },
    });
    contents.emitDbg('Fetch.requestPaused', { requestId: 'f-locked', request: { url: 'u' } });
    await waitFor(() => frames.some((f) => f.method === 'Fetch.requestPaused'));
    handle.setClientsLocked(false);
    const r = await call('Network.getRequestPostData', { requestId: 'r-locked' });
    expect(r.error).toEqual({ code: -32000, message: 'post data hidden: request made while recording' });
    const r2 = await call('Network.getRequestPostData', { requestId: 'f-locked' });
    expect(r2.error?.message).toMatch(/^post data hidden/);
    expect(contents.sent.length).toBe(0);
  });

  it('forwards requests seen while unlocked normally when no secret is live', async () => {
    contents.emitDbg('Network.requestWillBeSent', { requestId: 'r-free', request: { url: 'u', postData: 'q=1' } });
    await waitFor(() => frames.some((f) => f.method === 'Network.requestWillBeSent'));
    expect(frames.find((f) => f.method === 'Network.requestWillBeSent')!.params.request.postData).toBe('q=1');
    contents.commandResult = { postData: 'q=1' };
    const r = await call('Network.getRequestPostData', { requestId: 'r-free' });
    expect(r.error).toBeUndefined();
    expect(contents.sent).toEqual([{ method: 'Network.getRequestPostData', params: { requestId: 'r-free' } }]);
  });

  it('strips request bodies from Fetch.requestPaused while a secret is live', async () => {
    handle.addSecret(contents.id, SECRET);
    contents.emitDbg('Fetch.requestPaused', {
      requestId: 'f1',
      request: { url: 'u', postData: `pw=${SECRET}`, postDataEntries: [{ bytes: 'eA==' }] },
    });
    await waitFor(() => frames.some((f) => f.method === 'Fetch.requestPaused'));
    const f = frames.find((x) => x.method === 'Fetch.requestPaused')!;
    expect(f.params.request).toEqual({ url: 'u' });
  });

  it('keeps redacting after navigation and after detach + re-attach', async () => {
    handle.addSecret(contents.id, SECRET);
    contents.emitDbg('Page.frameNavigated', { frame: { id: '1', url: 'https://x.test/next' } });
    contents.emitDbg('Runtime.consoleAPICalled', { m: SECRET, n: 1 });
    await waitFor(() => frames.some((f) => f.params?.n === 1));
    expect(frames.find((f) => f.params?.n === 1)!.params.m).toBe('«segredo»');

    handle.detach();
    expect(handle.attach(contents.id)).toEqual({ ok: true });
    contents.emitDbg('Runtime.consoleAPICalled', { m: SECRET, n: 2 });
    await waitFor(() => frames.some((f) => f.params?.n === 2));
    expect(frames.find((f) => f.params?.n === 2)!.params.m).toBe('«segredo»');
  });

  it('keeps numeric secrets from corrupting JSON numbers and arrays (R14)', async () => {
    const otp = '483917';
    handle.addSecret(contents.id, otp);
    contents.emitDbg('Network.responseReceived', {
      timestamp: 1730212483917.25,
      digits: [4, 8, 3, 9, 1, 7],
      text: `codigo ${otp}`,
      n: 4,
    });
    await waitFor(() => frames.some((f) => f.method === 'Network.responseReceived'));
    const f = frames.find((x) => x.method === 'Network.responseReceived')!;
    expect(f.params.timestamp).toBe(1730212483917.25);
    expect(f.params.digits).toEqual([4, 8, 3, 9, 1, 7]);
    expect(f.params.text).toBe('codigo «segredo»');
  });

  it('redacts secrets in object keys', async () => {
    handle.addSecret(contents.id, SECRET);
    contents.emitDbg('Runtime.consoleAPICalled', { [SECRET]: 1, n: 5 });
    await waitFor(() => frames.some((f) => f.params?.n === 5));
    expect(Object.keys(frames.find((f) => f.params?.n === 5)!.params)).toEqual(['«segredo»', 'n']);
  });

  it('refuses page JS while a live secret sits in a field (R13)', async () => {
    handle.addSecret(contents.id, SECRET);
    contents.probeValue = true;
    for (const method of [
      'Runtime.evaluate',
      'Runtime.callFunctionOn',
      'Runtime.compileScript',
      'Debugger.evaluateOnCallFrame',
    ]) {
      const r = await call(method, { expression: 'document.body.innerHTML' });
      expect(r.error).toEqual({ code: -32000, message: 'bloqueado: campo com segredo preenchido na página' });
    }
    expect(contents.sent).toEqual([]);
    expect(contents.probes.length).toBe(4);
    expect(JSON.stringify(frames)).not.toContain(SECRET);
  });

  it('passes probed secrets only as call arguments, never in probe source (R16)', async () => {
    handle.addSecret(contents.id, SECRET);
    contents.probeValue = true;
    await call('Runtime.evaluate', { expression: '1' });
    const probe = contents.probes[0]!;
    expect(probe.functionDeclaration).not.toContain(SECRET);
    expect(probe.arguments).toEqual([{ value: [SECRET] }]);
    for (const cmd of contents.internal) {
      const { arguments: _args, ...rest } = cmd.params as Record<string, unknown>;
      expect(JSON.stringify(rest)).not.toContain(SECRET);
    }
    expect(contents.internal.map((c) => c.method)).toContain('Runtime.releaseObjectGroup');
  });

  it('does not refuse page JS after a username-only fill (R16)', async () => {
    handle.addSecret(contents.id, 'joao.silva', { probe: false });
    contents.probeValue = true;
    const r = await call('Runtime.callFunctionOn', { functionDeclaration: 'function(){this.click()}' });
    expect(r.error).toBeUndefined();
    expect(contents.probes).toEqual([]);
    expect(contents.sent.map((c) => c.method)).toEqual(['Runtime.callFunctionOn']);
  });

  it('keeps refusing after a password fill and probes only probed secrets (R16)', async () => {
    handle.addSecret(contents.id, 'joao.silva', { probe: false });
    handle.addSecret(contents.id, SECRET, { probe: true });
    contents.probeValue = true;
    const r = await call('Runtime.callFunctionOn', { functionDeclaration: 'function(){}' });
    expect(r.error?.message).toBe('bloqueado: campo com segredo preenchido na página');
    expect(contents.probes[0]!.arguments).toEqual([{ value: [SECRET] }]);
    expect(contents.sent).toEqual([]);
  });

  it('a username later filled as a password becomes probed (R16)', async () => {
    handle.addSecret(contents.id, SECRET, { probe: false });
    handle.addSecret(contents.id, SECRET, { probe: true });
    handle.addSecret(contents.id, SECRET, { probe: false });
    contents.probeValue = true;
    const r = await call('Runtime.evaluate', { expression: '1' });
    expect(r.error?.message).toBe('bloqueado: campo com segredo preenchido na página');
  });

  it('ignores secrets shorter than the redaction minimum when probing (R16)', async () => {
    handle.addSecret(contents.id, 'abc');
    contents.probeValue = true;
    const r = await call('Runtime.evaluate', { expression: '1' });
    expect(r.error).toBeUndefined();
    expect(contents.probes).toEqual([]);
  });

  it('refuses page JS when the probe does not answer within 2 s (R16)', async () => {
    handle.addSecret(contents.id, SECRET);
    contents.probeHangs = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const tick = () => new Promise((r) => setImmediate(r));
      const id = 424242;
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: '1' } }));
      for (let i = 0; i < 20 && contents.probes.length === 0; i++) await tick();
      expect(contents.probes.length).toBe(1);
      await vi.advanceTimersByTimeAsync(1_900);
      for (let i = 0; i < 10; i++) await tick();
      expect(frames.some((f) => f.id === id)).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      for (let i = 0; i < 20 && !frames.some((f) => f.id === id); i++) await tick();
      const r = frames.find((f) => f.id === id)!;
      expect(r.error).toEqual({ code: -32000, message: 'bloqueado: campo com segredo preenchido na página' });
      expect(contents.sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards page JS when the probe finds no secret in a field', async () => {
    handle.addSecret(contents.id, SECRET);
    contents.probeValue = false;
    const r = await call('Runtime.callFunctionOn', { functionDeclaration: 'function(){}' });
    expect(r.error).toBeUndefined();
    expect(contents.sent).toEqual([
      { method: 'Runtime.callFunctionOn', params: { functionDeclaration: 'function(){}' } },
    ]);
    expect(contents.probes.length).toBe(1);
  });

  it('fails closed when the probe does not return false', async () => {
    handle.addSecret(contents.id, SECRET);
    contents.probeValue = undefined;
    const r = await call('Runtime.evaluate', { expression: '1' });
    expect(r.error?.message).toBe('bloqueado: campo com segredo preenchido na página');
    expect(contents.sent).toEqual([]);
  });

  it('does not probe without a live secret or for non-JS methods', async () => {
    await call('Runtime.evaluate', { expression: '1' });
    handle.addSecret(contents.id, SECRET);
    contents.probeValue = true;
    await call('Page.navigate', { url: 'https://x.test/' });
    expect(contents.probes).toEqual([]);
    expect(contents.sent.map((c) => c.method)).toEqual(['Runtime.evaluate', 'Page.navigate']);
  });

  it('reports the lock state', () => {
    expect(handle.isClientsLocked()).toBe(false);
    handle.setClientsLocked(true, 'gravando');
    expect(handle.isClientsLocked()).toBe(true);
    handle.setClientsLocked(false);
    expect(handle.isClientsLocked()).toBe(false);
  });

  it('clears secrets when the webContents is destroyed', async () => {
    handle.addSecret(contents.id, SECRET);
    contents.destroy();
    contents = new FakeContents();
    expect(handle.attach(contents.id)).toEqual({ ok: true });
    contents.emitDbg('Runtime.consoleAPICalled', { m: SECRET, n: 3 });
    await waitFor(() => frames.some((f) => f.params?.n === 3));
    expect(frames.find((f) => f.params?.n === 3)!.params.m).toBe(SECRET);
  });
});
