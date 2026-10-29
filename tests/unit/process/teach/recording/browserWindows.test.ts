import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sessions } = vi.hoisted(() => ({ sessions: new Map<string, unknown>() }));

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '/tmp' },
  session: {
    fromPartition: (name: string) => {
      if (!sessions.has(name)) sessions.set(name, new (require('node:events').EventEmitter)());
      return sessions.get(name);
    },
  },
}));

import {
  installBrowserWindowHandlers,
  shouldManageBrowserContents,
  uniqueFileName,
} from '@process/services/teach/recording/browserWindows';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';

type Handler = (d: { url: string }) => { action: string };

const makeContents = (id = 7) => {
  let handler: Handler | undefined;
  const setCalls: Handler[] = [];
  return {
    setCalls,
    id,
    setWindowOpenHandler: (h: Handler) => {
      setCalls.push(h);
      handler = h;
    },
    open: (url: string) => handler!({ url }),
  };
};

const makeItem = (fileName: string, url = 'https://portal.gov.br/rel') => {
  const item = new EventEmitter() as EventEmitter & Record<string, unknown>;
  item.getFilename = () => fileName;
  item.getURL = () => url;
  item.setSavePath = vi.fn();
  return item;
};

describe('uniqueFileName', () => {
  it('keeps free names', () => {
    expect(uniqueFileName('/d', 'relatorio.pdf', () => false)).toBe('relatorio.pdf');
  });
  it('adds a counter before the extension', () => {
    const taken = new Set(['/d/relatorio.pdf']);
    expect(uniqueFileName('/d', 'relatorio.pdf', (p) => taken.has(p))).toBe('relatorio (1).pdf');
    taken.add('/d/relatorio (1).pdf');
    expect(uniqueFileName('/d', 'relatorio.pdf', (p) => taken.has(p))).toBe('relatorio (2).pdf');
  });
  it('handles names without extension', () => {
    expect(uniqueFileName('/d', 'dados', (p) => p === '/d/dados')).toBe('dados (1)');
  });
});

describe('installBrowserWindowHandlers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'jr-dl-'));
    sessions.clear();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deps = () => ({ emitOpenTab: vi.fn(), downloadsDir: path.join(dir, 'JR Bot'), onDownload: vi.fn() });

  it('denies window.open and emits for http(s) urls', () => {
    const c = makeContents(7);
    const d = deps();
    installBrowserWindowHandlers(c as never, d);
    expect(c.open('https://x/rel.pdf')).toEqual({ action: 'deny' });
    expect(d.emitOpenTab).toHaveBeenCalledWith('https://x/rel.pdf', 7);
  });

  it('denies but does not emit for javascript: and file: urls', () => {
    const c = makeContents();
    const d = deps();
    installBrowserWindowHandlers(c as never, d);
    expect(c.open('javascript:alert(1)')).toEqual({ action: 'deny' });
    expect(c.open('file:///etc/passwd')).toEqual({ action: 'deny' });
    expect(c.open('not a url')).toEqual({ action: 'deny' });
    expect(d.emitOpenTab).not.toHaveBeenCalled();
  });

  it('reports completed downloads saved under downloadsDir', () => {
    const d = deps();
    installBrowserWindowHandlers(makeContents() as never, d);
    const ses = sessions.get(BROWSER_SESSION_PARTITION) as EventEmitter;
    const item = makeItem('rel.pdf');
    ses.emit('will-download', {}, item);
    const savePath = (item.setSavePath as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(savePath).toBe(path.join(d.downloadsDir, 'rel.pdf'));
    item.emit('done', {}, 'completed');
    expect(d.onDownload).toHaveBeenCalledWith({
      fileName: 'rel.pdf',
      path: savePath,
      origin: 'https://portal.gov.br',
    });
  });

  it('does not report cancelled downloads', () => {
    const d = deps();
    installBrowserWindowHandlers(makeContents() as never, d);
    const ses = sessions.get(BROWSER_SESSION_PARTITION) as EventEmitter;
    const item = makeItem('rel.pdf');
    ses.emit('will-download', {}, item);
    item.emit('done', {}, 'cancelled');
    expect(d.onDownload).not.toHaveBeenCalled();
  });

  it('registers the session listener once and the window handler idempotently', () => {
    const d = deps();
    const a = makeContents(1);
    installBrowserWindowHandlers(a as never, d);
    installBrowserWindowHandlers(a as never, d);
    expect(a.setCalls).toHaveLength(1);
    installBrowserWindowHandlers(makeContents(2) as never, d);
    const ses = sessions.get(BROWSER_SESSION_PARTITION) as EventEmitter;
    expect(ses.listenerCount('will-download')).toBe(1);
  });
});

describe('shouldManageBrowserContents', () => {
  const browser = {} as never;
  it('accepts webviews on the browser session only', () => {
    expect(shouldManageBrowserContents({ getType: () => 'webview', session: browser } as never, browser)).toBe(true);
    expect(shouldManageBrowserContents({ getType: () => 'webview', session: {} } as never, browser)).toBe(false);
    expect(shouldManageBrowserContents({ getType: () => 'window', session: browser } as never, browser)).toBe(false);
  });
});
