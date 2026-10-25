/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { UpdateInfo } from 'electron-updater';
import type { AppUpdater } from 'electron-updater/out/AppUpdater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { CdnGenericProvider } from '@/process/services/cdnGenericProvider';
import { buildCdnFeedOptions, CDN_UPDATE_BASE_URL } from '@/process/services/updateFeed';

const makeRuntimeOptions = (): ProviderRuntimeOptions => ({
  isUseMultipleRangeRequest: true,
  platform: 'darwin',
  executor: {
    request: vi.fn(),
  } as unknown as ProviderRuntimeOptions['executor'],
});

describe('CDN update feed options', () => {
  it('builds a custom electron-updater provider pointed at the release CDN', () => {
    const options = buildCdnFeedOptions();

    expect(options.provider).toBe('custom');
    expect(options.url).toBe(CDN_UPDATE_BASE_URL);
    expect(options.updateProvider).toBe(CdnGenericProvider);
  });
});

describe('CdnGenericProvider', () => {
  it('resolves installer files beside latest.yml', () => {
    const provider = new CdnGenericProvider(
      {
        provider: 'custom',
        url: CDN_UPDATE_BASE_URL,
      },
      {} as AppUpdater,
      { ...makeRuntimeOptions(), platform: 'win32' }
    );

    const files = provider.resolveFiles({
      version: '2.2.3',
      files: [
        {
          url: 'JR-Santa-Fe-Bot-Setup-2.2.3.exe',
          sha512: 'sha512-value',
        },
      ],
      path: 'JR-Santa-Fe-Bot-Setup-2.2.3.exe',
      sha512: 'sha512-value',
      releaseDate: '2026-10-23T00:00:00.000Z',
    } satisfies UpdateInfo);

    expect(files[0]?.url.href).toBe('https://jrsantafe.stratacerta.com.br/mmx/updates/JR-Santa-Fe-Bot-Setup-2.2.3.exe');
  });

  it('requests Windows metadata from the company feed root', async () => {
    const request = vi.fn().mockResolvedValue(`version: 2.2.4
files:
  - url: JR-Santa-Fe-Bot-Setup-2.2.4.exe
    sha512: sha512-value
path: JR-Santa-Fe-Bot-Setup-2.2.4.exe
sha512: sha512-value
releaseDate: '2026-10-23T00:00:00.000Z'
`);
    const provider = new CdnGenericProvider(
      { provider: 'custom', url: CDN_UPDATE_BASE_URL },
      { isAddNoCacheQuery: false } as AppUpdater,
      {
        isUseMultipleRangeRequest: false,
        platform: 'win32',
        executor: { request } as unknown as ProviderRuntimeOptions['executor'],
      }
    );

    await provider.getLatestVersion();

    const options = request.mock.calls[0]?.[0] as { hostname?: string; path?: string };
    expect(options.hostname).toBe('jrsantafe.stratacerta.com.br');
    expect(options.path).toBe('/mmx/updates/latest.yml');
    expect(`${options.hostname}${options.path}`).not.toContain('aionui.com');
  });
});
