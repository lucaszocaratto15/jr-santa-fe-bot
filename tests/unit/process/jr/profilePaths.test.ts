import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
const paths = vi.hoisted(() => ({ data: '', home: '' }));
vi.mock('@/common/platform', () => ({
  getPlatformServices: () => ({
    paths: { needsCliSafeSymlinks: () => true, getDataDir: () => paths.data, getHomeDir: () => paths.home },
  }),
}));
vi.mock('@/common/config/appEnv', () => ({ getEnvAwareName: (name: string) => name + '-dev-2' }));
import { getDataPath, getConfigPath } from '@/process/utils/utils';
it('keeps CLI aliases bound to their original profile when another instance opens', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jr-profiles-')));
  paths.home = root;
  try {
    paths.data = join(root, 'owner');
    const ownerData = getDataPath(),
      ownerConfig = getConfigPath();
    paths.data = join(root, 'employee');
    const employeeData = getDataPath(),
      employeeConfig = getConfigPath();
    expect(ownerData).not.toBe(employeeData);
    expect(ownerConfig).not.toBe(employeeConfig);
    expect(await realpath(ownerData)).toBe(join(root, 'owner', 'aionui'));
    expect(await realpath(ownerConfig)).toBe(join(root, 'owner', 'config'));
    expect(await realpath(employeeData)).toBe(join(root, 'employee', 'aionui'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
