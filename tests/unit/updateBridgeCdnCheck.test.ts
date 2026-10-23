/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common/platform/bridge', () => ({
  bridge: {
    buildProvider: vi.fn(() => {
      const handlerMap = new Map<string, Function>();
      return {
        provider: vi.fn((handler: Function) => {
          handlerMap.set('handler', handler);
          return vi.fn();
        }),
        invoke: vi.fn(),
        _getHandler: () => handlerMap.get('handler'),
      };
    }),
    buildEmitter: vi.fn(() => ({
      emit: vi.fn(),
      on: vi.fn(),
    })),
  },
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '2.1.40'),
    getPath: vi.fn(() => '/test/path'),
    exit: vi.fn(),
    isPackaged: true,
  },
  autoUpdater: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    setFeedURL: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    checkForUpdatesAndNotify: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    transports: { file: { level: 'info' } },
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@process/services/i18n', () => ({
  default: { t: (key: string) => key },
}));

// The fixtures below are mac-arm64 assets and both resolveCdnChannelFile and
// pickRecommendedAsset read the host platform/arch, so pin the runtime to keep
// results identical on every CI runner (linux/windows x64 would otherwise
// filter the assets out and pick no recommended asset).
import { afterAll, beforeAll } from 'vitest';

const realPlatform = process.platform;
const realArch = process.arch;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
});

const FEED_YML = `version: 2.1.45
files:
  - url: JR-Santa-Fe-Bot-Setup-2.1.45.exe
    size: 200
path: JR-Santa-Fe-Bot-Setup-2.1.45.exe
releaseDate: '2026-07-31T14:45:19.381Z'
`;
const FEED_MANIFEST_URL = 'https://jrsantafe.stratacerta.com.br/mmx/updates/latest.yml';

const getCheckHandler = async () => {
  vi.resetModules();
  const { initUpdateBridge } = await import('@process/bridge/updateBridge');
  const { ipcBridge } = await import('@/common');
  initUpdateBridge();
  const provider = vi.mocked(ipcBridge.update.check.provider);
  const lastCall = provider.mock.calls.at(-1);
  if (!lastCall) throw new Error('update.check handler not registered');
  return lastCall[0];
};

const stubFetch = (manifest: () => Promise<Response> | Response) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === FEED_MANIFEST_URL) return manifest();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const ymlResponse = (body: string) => new Response(body, { status: 200 });

describe('update.check CDN-first', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports an update from the company latest.yml and does not call another host', async () => {
    const fetchMock = stubFetch(() => ymlResponse(FEED_YML));
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(true);
    expect(res.data?.updateAvailable).toBe(true);
    expect(res.data?.latest?.version).toBe('2.1.45');
    expect(res.data?.latest?.htmlUrl).toBe('');
    expect(res.data?.latest?.recommendedAsset?.url).toBe(
      'https://jrsantafe.stratacerta.com.br/mmx/updates/JR-Santa-Fe-Bot-Setup-2.1.45.exe'
    );
    expect(fetchMock).toHaveBeenCalledWith(FEED_MANIFEST_URL, expect.any(Object));
    expect(fetchMock.mock.calls.map((call) => String(call[0])).join('\n')).not.toMatch(/aionui|github/i);
  });

  it('reports up-to-date when the feed version equals the installed version', async () => {
    stubFetch(() => ymlResponse(FEED_YML.replace(/2\.1\.45/g, '2.1.40')));
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(true);
    expect(res.data?.updateAvailable).toBe(false);
  });

  it('fails the check when the feed request fails', async () => {
    stubFetch(() => new Response('nope', { status: 502 }));
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(false);
  });

  it('fails the check when the feed manifest is malformed', async () => {
    stubFetch(() => ymlResponse('not: [valid'));
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(false);
  });
});
