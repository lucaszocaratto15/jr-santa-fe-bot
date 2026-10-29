import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVaultStore } from '@/process/services/teach/vault/vault';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fakeEncryption = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text: string) => Buffer.from(text.split('').reverse().join('')),
  decryptString: (buffer: Buffer) => buffer.toString().split('').reverse().join(''),
});

const setup = async (available = true) => {
  const root = await mkdtemp(join(tmpdir(), 'jr-vault-'));
  roots.push(root);
  return { root, store: createVaultStore(root, fakeEncryption(available)) };
};
const file = (root: string) => join(root, 'jr-vault', 'vault.json');
const input = { name: 'Portal', origins: ['portal.gov.br/login'], username: 'maria', password: 'S3nh@', hints: 'h' };

describe('vault store', () => {
  it('never stores the password in plaintext', async () => {
    const { root, store } = await setup();
    await store.upsert(input);
    const bytes = await readFile(file(root));
    expect(bytes.toString()).not.toContain('S3nh@');
    expect(JSON.parse(bytes.toString()).items[0].origins).toEqual(['https://portal.gov.br']);
  });

  it('list() never returns the password', async () => {
    const { store } = await setup();
    const saved = await store.upsert(input);
    const listed = await store.list();
    expect(JSON.stringify(listed)).not.toContain('S3nh@');
    expect(JSON.stringify(saved)).not.toContain('S3nh@');
    expect(listed[0]).toMatchObject({ name: 'Portal', username: 'maria', hasPassword: true, hints: 'h' });
  });

  it('upsert without password keeps the old one', async () => {
    const { store } = await setup();
    const saved = await store.upsert(input);
    const updated = await store.upsert({ id: saved.id, name: 'Portal 2', origins: ['portal.gov.br'], username: 'ana' });
    expect(updated.id).toBe(saved.id);
    expect(await store.readSecret(saved.id, 'password')).toBe('S3nh@');
    expect(await store.readSecret(saved.id, 'username')).toBe('ana');
    expect(await store.list()).toHaveLength(1);
  });

  it('readSecret returns null for unknown ids', async () => {
    const { store } = await setup();
    expect(await store.readSecret('nope', 'password')).toBeNull();
  });

  it('remove() deletes one item', async () => {
    const { store } = await setup();
    const a = await store.upsert(input);
    await store.upsert({ ...input, name: 'B' });
    await store.remove(a.id);
    expect((await store.list()).map((i) => i.name)).toEqual(['B']);
  });

  it('rejects invalid origins', async () => {
    const { store } = await setup();
    await expect(store.upsert({ ...input, origins: ['not a url'] })).rejects.toThrow();
  });

  it('is unavailable and refuses writes when encryption is unavailable', async () => {
    const { root, store } = await setup(false);
    expect(store.available()).toBe(false);
    await expect(store.upsert(input)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
    await expect(readFile(file(root))).rejects.toThrow();
  });

  it('is unavailable with the basic_text backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jr-vault-'));
    roots.push(root);
    const store = createVaultStore(root, { ...fakeEncryption(), getSelectedStorageBackend: () => 'basic_text' });
    expect(store.available()).toBe(false);
  });

  it('wipe() removes every item', async () => {
    const { store } = await setup();
    await store.upsert(input);
    await store.upsert({ ...input, name: 'B' });
    await store.wipe();
    expect(await store.list()).toEqual([]);
  });

  it('wipe() works when encryption is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jr-vault-'));
    roots.push(root);
    await createVaultStore(root, fakeEncryption(true)).upsert(input);
    const store = createVaultStore(root, fakeEncryption(false));
    await expect(store.wipe()).resolves.toBeUndefined();
    await expect(readFile(file(root))).rejects.toThrow();
    await expect(store.wipe()).resolves.toBeUndefined();
  });

  it('file is written with mode 0o600', async () => {
    if (process.platform === 'win32') return;
    const { root, store } = await setup();
    await store.upsert(input);
    expect((await stat(file(root))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'jr-vault'))).mode & 0o777).toBe(0o700);
  });
});
