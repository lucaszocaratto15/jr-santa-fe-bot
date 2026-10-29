import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

class FakeContents extends EventEmitter {
  id = 7;
  destroyed = false;
  sent: Array<{ method: string; params: unknown }> = [];
  commandResult: unknown = {};
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
