import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Session, WebContents } from 'electron';
import { app, session } from 'electron';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';

export type DownloadInfo = { fileName: string; path: string; origin: string };

export type BrowserWindowDeps = {
  emitOpenTab(url: string, openerId: number): void;
  downloadsDir: string;
  onDownload(info: DownloadInfo): void;
};

/** `relatorio.pdf` -> `relatorio (1).pdf` when the name is taken. */
export function uniqueFileName(dir: string, name: string, exists: (p: string) => boolean): string {
  if (!exists(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!exists(path.join(dir, candidate))) return candidate;
  }
}

/** True for webviews that belong to the in-app browser partition (and nothing else). */
export function shouldManageBrowserContents(
  wc: Pick<WebContents, 'getType' | 'session'>,
  browserSession: Session
): boolean {
  return wc.getType() === 'webview' && wc.session === browserSession;
}

/** Wire popup/download handling for every in-app browser webview as soon as it is created. */
export function registerBrowserWindowHandlers(deps: BrowserWindowDeps): void {
  app.on('web-contents-created', (_event, wc) => {
    if (shouldManageBrowserContents(wc, session.fromPartition(BROWSER_SESSION_PARTITION))) {
      installBrowserWindowHandlers(wc, deps);
    }
  });
}

const installedContents = new WeakSet<object>();
const installedSessions = new WeakSet<object>();

const safeOrigin = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/**
 * Route popups / target=_blank of an in-app browser webview into new browser tabs and
 * save downloads of the browser partition to `deps.downloadsDir`. Idempotent per
 * webContents (a webview may report its id more than once); the `will-download`
 * listener is registered once per session.
 */
export function installBrowserWindowHandlers(contents: WebContents, deps: BrowserWindowDeps): void {
  if (!installedContents.has(contents)) {
    installedContents.add(contents);
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const protocol = new URL(url).protocol;
        if (protocol === 'http:' || protocol === 'https:') deps.emitOpenTab(url, contents.id);
      } catch {
        // malformed url: just deny
      }
      return { action: 'deny' };
    });
  }

  const ses = session.fromPartition(BROWSER_SESSION_PARTITION);
  if (installedSessions.has(ses)) return;
  installedSessions.add(ses);
  ses.on('will-download', (_event, item) => {
    let dir = deps.downloadsDir;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      dir = app.getPath('downloads');
    }
    const fileName = uniqueFileName(dir, item.getFilename(), existsSync);
    const savePath = path.join(dir, fileName);
    item.setSavePath(savePath);
    const origin = safeOrigin(item.getURL());
    item.once('done', (_e, state) => {
      if (state === 'completed') deps.onDownload({ fileName, path: savePath, origin });
    });
  });
}
