import { randomUUID } from 'node:crypto';
import { chmod, constants, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { OsEncryption } from '../../jr/auth';
import type { VaultItemPublic, VaultUpsert } from '@/common/types/agent/teachTypes';
import { normalizeOrigin } from './originMatch';

export type { VaultItemPublic, VaultUpsert };
export type VaultStore = {
  available(): boolean;
  list(): Promise<VaultItemPublic[]>;
  upsert(input: VaultUpsert): Promise<VaultItemPublic>;
  remove(id: string): Promise<void>;
  wipe(): Promise<void>;
  /** Main process only. Never wire this to IPC. */
  readSecret(id: string, field: 'username' | 'password'): Promise<string | null>;
};

type StoredItem = {
  id: string;
  name: string;
  origins: string[];
  username: string;
  /** base64 of encryptString(password); empty when no password is stored. */
  passwordEnc: string;
  hints: string;
};
type VaultFile = { version: 1; items: StoredItem[] };

const MAX_FILE_BYTES = 1_048_576;

const unavailable = () => new Error('JR_VAULT_UNAVAILABLE');
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const toPublic = (item: StoredItem): VaultItemPublic => ({
  id: item.id,
  name: item.name,
  origins: [...item.origins],
  username: item.username,
  hasPassword: item.passwordEnc !== '',
  hints: item.hints,
});

const parseFile = (text: string): VaultFile => {
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.version !== 1 || !Array.isArray(value.items)) throw new Error('JR_VAULT_INVALID');
  const items = value.items.map((raw): StoredItem => {
    if (
      !record(raw) ||
      typeof raw.id !== 'string' ||
      typeof raw.name !== 'string' ||
      !Array.isArray(raw.origins) ||
      !raw.origins.every((o) => typeof o === 'string') ||
      typeof raw.username !== 'string' ||
      typeof raw.passwordEnc !== 'string' ||
      typeof raw.hints !== 'string'
    ) {
      throw new Error('JR_VAULT_INVALID');
    }
    return {
      id: raw.id,
      name: raw.name,
      origins: raw.origins as string[],
      username: raw.username,
      passwordEnc: raw.passwordEnc,
      hints: raw.hints,
    };
  });
  return { version: 1, items };
};

export function createVaultStore(userDataDir: string, encryption: OsEncryption): VaultStore {
  const directory = join(userDataDir, 'jr-vault');
  const file = join(directory, 'vault.json');
  const available = () =>
    isAbsolute(userDataDir) &&
    encryption.isEncryptionAvailable() &&
    encryption.getSelectedStorageBackend?.() !== 'basic_text';
  const requireAvailable = () => {
    if (!available()) throw unavailable();
  };

  const ensureDirectory = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    await chmod(directory, 0o700);
  };

  const load = async (): Promise<VaultFile> => {
    try {
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('JR_VAULT_INVALID');
        return parseFile(await handle.readFile({ encoding: 'utf8' }));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (record(error) && error.code === 'ENOENT') return { version: 1, items: [] };
      throw error;
    }
  };

  const save = async (data: VaultFile) => {
    await ensureDirectory();
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(data));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      await chmod(file, 0o600);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };

  return {
    available,
    async list() {
      if (!available()) return [];
      return (await load()).items.map(toPublic);
    },
    async upsert(input) {
      requireAvailable();
      const origins: string[] = [];
      for (const raw of input.origins) {
        const origin = normalizeOrigin(raw);
        if (!origin) throw new Error('JR_VAULT_INVALID_ORIGIN');
        if (!origins.includes(origin)) origins.push(origin);
      }
      if (origins.length === 0) throw new Error('JR_VAULT_INVALID_ORIGIN');
      const data = await load();
      const existing = input.id ? data.items.find((item) => item.id === input.id) : undefined;
      const passwordEnc =
        input.password === undefined
          ? (existing?.passwordEnc ?? '')
          : input.password === ''
            ? ''
            : encryption.encryptString(input.password).toString('base64');
      const next: StoredItem = {
        id: existing?.id ?? randomUUID(),
        name: input.name,
        origins,
        username: input.username,
        passwordEnc,
        hints: input.hints ?? existing?.hints ?? '',
      };
      data.items = existing ? data.items.map((item) => (item.id === existing.id ? next : item)) : [...data.items, next];
      await save(data);
      return toPublic(next);
    },
    async remove(id) {
      requireAvailable();
      const data = await load();
      data.items = data.items.filter((item) => item.id !== id);
      await save(data);
    },
    /** Needs no encryption: offboarding must work on machines without a usable keychain. */
    async wipe() {
      if (!isAbsolute(userDataDir)) throw unavailable();
      await unlink(file).catch((error: unknown) => {
        if (!(record(error) && error.code === 'ENOENT')) throw error;
      });
    },
    async readSecret(id, field) {
      if (!available()) return null;
      const item = (await load()).items.find((entry) => entry.id === id);
      if (!item) return null;
      if (field === 'username') return item.username;
      if (item.passwordEnc === '') return null;
      return encryption.decryptString(Buffer.from(item.passwordEnc, 'base64'));
    },
  };
}
