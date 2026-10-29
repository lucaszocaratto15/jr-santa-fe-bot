import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { WebContents } from 'electron';
import { session } from 'electron';
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
    mkdirSync(deps.downloadsDir, { recursive: true });
    const fileName = uniqueFileName(deps.downloadsDir, item.getFilename(), existsSync);
    const savePath = path.join(deps.downloadsDir, fileName);
    item.setSavePath(savePath);
    const origin = safeOrigin(item.getURL());
    item.once('done', (_e, state) => {
      if (state === 'completed') deps.onDownload({ fileName, path: savePath, origin });
    });
  });
}
