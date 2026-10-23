import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  isJrAdmin,
  type JrAccessState,
  type JrAccessUser,
  type JrEmployee,
  type JrInvite,
  type JrConnectionStatus,
} from '@/common/config/clientSettings';
import { parseJrConnectionStatus } from './usage';
import type { JrRelayConfig } from './bootstrap';

type Environment = Record<string, string | undefined>;
/** Idle session check. Startup and each gateway response are checked separately. */
export const JR_SESSION_CHECK_INTERVAL_MS = 60_000;
export type JrStoredSession = { deviceId: string; issuer: string; ownerId: string | null; token: string | null };
export type JrProxyDenial = { status: number; code: string | null };
export type JrSessionStore = {
  read: () => Promise<JrStoredSession | null>;
  write: (session: JrStoredSession) => Promise<void>;
};
type OsEncryption = {
  isEncryptionAvailable: () => boolean;
  getSelectedStorageBackend?: () => string;
  encryptString: (text: string) => Buffer;
  decryptString: (buffer: Buffer) => string;
};
type ControllerOptions = {
  url: string | null;
  store: JrSessionStore;
  configureCore: (connection: JrRelayConfig) => Promise<void>;
  /** Re-register the local pilot relay when this install is not using the company session. */
  ensurePilot?: () => Promise<void>;
  stopCore: () => Promise<void>;
  onChange: (state: JrAccessState) => void;
  request?: typeof fetch;
  pilot?: boolean;
  beforeFirstLogin?: () => Promise<void>;
};

function fail(code: string): never {
  throw new Error(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{32,512}$/.test(value);
}
function validClock(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(value);
}
async function responseCode(response: Response): Promise<string | null> {
  try {
    const value: unknown = await response.json();
    return record(value) && record(value.error) && typeof value.error.code === 'string' ? value.error.code : null;
  } catch {
    return null;
  }
}
const EMPLOYEE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function listedEmail(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 120 || hasControlCharacter(value))
    return fail('JR_ACCESS_INVALID_RESPONSE');
  const email = value.trim();
  if (!email) return null;
  if (!EMPLOYEE_EMAIL.test(email)) return fail('JR_ACCESS_INVALID_RESPONSE');
  return email;
}

/** Older control servers omit title. A missing value is not an error. */
function listedTitle(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || hasControlCharacter(value)) return fail('JR_ACCESS_INVALID_RESPONSE');
  const title = value.trim();
  if (!title) return null;
  if (title.length > 80) return fail('JR_ACCESS_INVALID_RESPONSE');
  return title;
}

function inviteTitle(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return fail('JR_ACCESS_INVALID_NAME');
  const title = value.trim();
  if (!title) return null;
  if (title.length > 80 || hasControlCharacter(title)) return fail('JR_ACCESS_INVALID_NAME');
  return title;
}

function inviteEmail(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return fail('JR_ACCESS_INVALID_EMAIL');
  const email = value.trim();
  if (!email) return null;
  if (email.length > 120 || hasControlCharacter(email) || !EMPLOYEE_EMAIL.test(email))
    return fail('JR_ACCESS_INVALID_EMAIL');
  return email;
}

function restrictionStatus(code: string): 'blocked' | 'outside-hours' | null {
  if (code === 'employee_blocked') return 'blocked';
  if (code === 'outside_access_hours') return 'outside-hours';
  return null;
}
function accessRole(value: unknown): JrAccessUser['role'] | null {
  if (typeof value !== 'string') return null;
  const role = value.trim().toLocaleLowerCase('pt-BR');
  if (role === 'admin' || role === 'administrator' || role === 'administrador') return 'admin';
  if (role === 'employee' || role === 'funcionario' || role === 'funcionário') return 'employee';
  return null;
}

function parseUser(value: unknown): JrAccessUser {
  if (
    !record(value) ||
    !validId(value.id) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 120
  ) {
    return fail('JR_ACCESS_INVALID_RESPONSE');
  }
  // The seeded owner stays an administrator after session.enc restore, even when
  // a stored role label drifted away from the exact word "admin".
  const role = value.id === 'owner' ? 'admin' : accessRole(value.role);
  if (!role) return fail('JR_ACCESS_INVALID_RESPONSE');
  return { id: value.id, name: value.name, role };
}

/** Resolve the explicitly configured control service; insecure HTTP is test-only. */
export function getJrControlUrl(env: Environment = process.env): string | null {
  const configured = env.JR_CONTROL_URL === undefined ? 'https://jrsantafe.stratacerta.com.br/bot' : env.JR_CONTROL_URL;
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return fail('JR_ACCESS_INVALID_URL');
  }
  const localTest =
    env.JR_ALLOW_INSECURE_CONTROL_TEST === '1' &&
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    Boolean(url.port);
  if ((!localTest && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash)
    return fail('JR_ACCESS_INVALID_URL');
  return url.toString().replace(/\/+$/, '');
}

/** Store the revocable session and installation binding using OS encryption only. */
export function createJrSessionStore(root: string, encryption: OsEncryption): JrSessionStore {
  if (!isAbsolute(root)) return fail('JR_ACCESS_STORAGE_UNAVAILABLE');
  const directory = join(root, 'jr-access');
  const file = join(directory, 'session.enc');
  const checkEncryption = () => {
    if (!encryption.isEncryptionAvailable() || encryption.getSelectedStorageBackend?.() === 'basic_text')
      fail('JR_ACCESS_STORAGE_UNAVAILABLE');
  };
  const ensureDirectory = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('JR_ACCESS_STORAGE_UNAVAILABLE');
    await chmod(directory, 0o700);
  };
  return {
    async read() {
      checkEncryption();
      try {
        await ensureDirectory();
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        let encrypted: Buffer;
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 16384) return fail('JR_ACCESS_STORAGE_INVALID');
          encrypted = await handle.readFile();
        } finally {
          await handle.close();
        }
        const value: unknown = JSON.parse(encryption.decryptString(encrypted));
        if (
          !record(value) ||
          !validId(value.deviceId) ||
          typeof value.issuer !== 'string' ||
          (value.ownerId !== null && !validId(value.ownerId)) ||
          (value.token !== null && !validToken(value.token))
        ) {
          return fail('JR_ACCESS_STORAGE_INVALID');
        }
        return {
          deviceId: value.deviceId,
          issuer: value.issuer,
          ownerId: value.ownerId as string | null,
          token: value.token as string | null,
        };
      } catch (error) {
        if (record(error) && error.code === 'ENOENT') return null;
        return fail('JR_ACCESS_STORAGE_UNAVAILABLE');
      }
    },
    async write(value) {
      checkEncryption();
      await ensureDirectory();
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        const encrypted = encryption.encryptString(JSON.stringify(value));
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(encrypted);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, file);
        await chmod(file, 0o600);
      } catch {
        return fail('JR_ACCESS_STORAGE_UNAVAILABLE');
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },
  };
}

/** Native access controller. Session tokens never appear in renderer state or errors. */
export class JrAccessController {
  private current: JrAccessState = { status: 'checking', user: null };
  private saved: JrStoredSession | null = null;
  private generation = 0;
  private refreshing: Promise<JrAccessState> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly request: typeof fetch;
  private persistence: Promise<void> = Promise.resolve();
  private authenticating = false;
  private blockingTransitions = 0;
  constructor(private readonly options: ControllerOptions) {
    this.request = options.request || fetch;
  }
  get state(): JrAccessState {
    return { status: this.current.status, user: this.current.user ? { ...this.current.user } : null };
  }
  /** Retry connectivity on demand while preserving explicit logout and revocation notices. */
  accessStatus(): Promise<JrAccessState> {
    return ['offline', 'blocked', 'outside-hours'].includes(this.current.status)
      ? this.refresh()
      : Promise.resolve(this.state);
  }
  private publish(status: JrAccessState['status'], user: JrAccessUser | null = null): JrAccessState {
    this.current = { status, user };
    this.options.onChange(this.state);
    return this.state;
  }
  private async remote(path: string, init: RequestInit = {}, token = this.saved?.token): Promise<Response> {
    if (!this.options.url) return fail('JR_ACCESS_UNCONFIGURED');
    return this.request(`${this.options.url}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  }
  private async clearToken() {
    if (this.saved) {
      await this.persist({ ...this.saved, token: null });
    }
  }
  private async persist(value: JrStoredSession): Promise<void> {
    this.saved = value;
    const pending = this.persistence.catch(() => {}).then(() => this.options.store.write(value));
    this.persistence = pending;
    await pending;
  }
  private async stopCore(): Promise<boolean> {
    try {
      await this.options.stopCore();
      return true;
    } catch {
      this.publish('unconfigured');
      return false;
    }
  }
  private async blockTransitions<T>(operation: () => Promise<T>): Promise<T> {
    this.blockingTransitions += 1;
    try {
      return await operation();
    } finally {
      this.blockingTransitions -= 1;
    }
  }
  async rejectSession(expectedToken?: string): Promise<JrAccessState> {
    if (expectedToken && expectedToken !== this.saved?.token) return this.state;
    return this.blockTransitions(async () => {
      this.generation += 1;
      const token = this.saved?.token;
      this.publish('revoked');
      await this.stopCore();
      try {
        if (this.saved?.token === token) await this.clearToken();
      } catch {
        return this.publish('unconfigured');
      }
      return this.state;
    });
  }
  /** Hide company data when a gateway call reports a block or closed access hours. */
  noteGatewayRestriction(status: 'blocked' | 'outside-hours', expectedToken?: string): Promise<JrAccessState> {
    return this.applyRestriction(status, expectedToken);
  }
  private async applyRestriction(status: 'blocked' | 'outside-hours', expectedToken?: string): Promise<JrAccessState> {
    if (expectedToken && expectedToken !== this.saved?.token) return this.state;
    return this.blockTransitions(async () => {
      this.generation += 1;
      this.publish(status);
      const stopped = await this.stopCore();
      return stopped ? this.state : this.publish('unconfigured');
    });
  }
  async initialize(): Promise<JrAccessState> {
    if (this.options.pilot) return this.publish('pilot');
    if (!this.options.url) return this.publish('unconfigured');
    try {
      this.saved = await this.options.store.read();
      if (this.saved && this.saved.issuer !== this.options.url) return this.publish('unconfigured');
    } catch {
      return this.publish('unconfigured');
    }
    if (!this.saved?.token) return this.publish('signed-out');
    return this.refresh();
  }
  startHeartbeat(): void {
    if (this.timer || this.options.pilot || !this.options.url) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, JR_SESSION_CHECK_INTERVAL_MS);
    this.timer.unref();
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  private async verifyModel(token: string): Promise<string> {
    const response = await this.remote('/v1/models', {}, token);
    if (response.status === 401) {
      await this.rejectSession();
      return fail('JR_ACCESS_REVOKED');
    }
    if (response.status === 403) {
      const restriction = restrictionStatus((await responseCode(response)) ?? '');
      if (restriction) {
        await this.applyRestriction(restriction, token);
        return fail(restriction === 'blocked' ? 'JR_ACCESS_BLOCKED' : 'JR_ACCESS_OUTSIDE_HOURS');
      }
    }
    if (!response.ok) return fail('JR_ACCESS_UNAVAILABLE');
    const result: unknown = await response.json();
    const model = 'MiniMax-M3.1-Flash';
    if (
      !record(result) ||
      !Array.isArray(result.data) ||
      !result.data.some((item) => record(item) && item.id === model)
    )
      return fail('JR_ACCESS_INVALID_MODEL');
    return model;
  }
  async refresh(): Promise<JrAccessState> {
    if (this.refreshing) return this.refreshing;
    if (
      !this.saved?.token ||
      !this.options.url ||
      this.options.pilot ||
      this.authenticating ||
      this.blockingTransitions > 0 ||
      ['signed-out', 'revoked', 'unconfigured', 'pilot'].includes(this.current.status)
    )
      return this.state;
    const epoch = this.generation;
    const token = this.saved.token;
    this.refreshing = (async () => {
      try {
        const response = await this.remote('/auth/session', {}, token);
        if (epoch !== this.generation) return this.state;
        if (response.status === 401) return this.rejectSession(token);
        if (response.status === 403) {
          const restriction = restrictionStatus((await responseCode(response)) ?? '');
          return restriction ? this.applyRestriction(restriction, token) : this.rejectSession(token);
        }
        if (!response.ok) return fail('JR_ACCESS_UNAVAILABLE');
        const value: unknown = await response.json();
        if (epoch !== this.generation) return this.state;
        const user = parseUser(record(value) ? value.user : null);
        if (user.id !== this.saved?.ownerId) return this.rejectSession(token);
        if (this.current.status !== 'authenticated') {
          const model = await this.verifyModel(token);
          if (epoch !== this.generation) return this.state;
          await this.options.configureCore({ url: `${this.options.url}/v1`, token, model });
          if (epoch !== this.generation) {
            await this.stopCore();
            return this.state;
          }
        }
        return this.publish('authenticated', user);
      } catch {
        if (epoch !== this.generation) return this.state;
        return this.blockTransitions(async () => {
          this.publish('offline');
          await this.stopCore();
          return this.state;
        });
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  async login(input: { code: string }): Promise<JrAccessState> {
    if (
      this.authenticating ||
      this.blockingTransitions > 0 ||
      this.current.status === 'authenticated' ||
      this.current.status === 'checking'
    )
      return fail('JR_ACCESS_BUSY');
    if (!this.options.url || this.options.pilot || this.current.status === 'unconfigured')
      return fail('JR_ACCESS_UNCONFIGURED');
    if (typeof input?.code !== 'string' || !input.code.trim() || input.code.length > 512)
      return fail('JR_ACCESS_INVALID_CODE');
    const epoch = ++this.generation;
    this.authenticating = true;
    this.publish('checking');
    const prior = this.saved || { deviceId: randomUUID(), issuer: this.options.url, ownerId: null, token: null };
    let acceptedToken: string | null = null;
    try {
      if (!prior.ownerId) await this.options.beforeFirstLogin?.();
      if (epoch !== this.generation) return fail('JR_ACCESS_BUSY');
      const response = await this.remote(
        '/auth/login',
        {
          method: 'POST',
          body: JSON.stringify({
            code: input.code.trim(),
            deviceId: prior.deviceId,
            deviceName: hostname().slice(0, 100),
            ...(prior.ownerId ? { employeeId: prior.ownerId } : {}),
          }),
        },
        null
      );
      if (response.status === 403) {
        const code = (await responseCode(response)) ?? '';
        const restriction = restrictionStatus(code);
        if (restriction) return fail(restriction === 'blocked' ? 'JR_ACCESS_BLOCKED' : 'JR_ACCESS_OUTSIDE_HOURS');
        return fail('JR_ACCESS_DEVICE_BOUND');
      }
      if (response.status === 401) return fail('JR_ACCESS_INVALID_CODE');
      if (!response.ok) return fail('JR_ACCESS_UNAVAILABLE');
      const value: unknown = await response.json();
      const user = parseUser(record(value) ? value.user : null);
      if (!record(value) || !validToken(value.token)) return fail('JR_ACCESS_INVALID_RESPONSE');
      acceptedToken = value.token;
      if (prior.ownerId && prior.ownerId !== user.id) return fail('JR_ACCESS_DEVICE_BOUND');
      const model = await this.verifyModel(acceptedToken);
      if (epoch !== this.generation) return fail('JR_ACCESS_BUSY');
      const next = { ...prior, ownerId: user.id, token: acceptedToken };
      await this.persist(next);
      if (epoch !== this.generation) return fail('JR_ACCESS_BUSY');
      await this.options.configureCore({ url: `${this.options.url}/v1`, token: acceptedToken, model });
      if (epoch !== this.generation) {
        await this.stopCore();
        return this.state;
      }
      return this.publish('authenticated', user);
    } catch (error) {
      const stopped = await this.stopCore();
      if (acceptedToken) await this.remote('/auth/logout', { method: 'POST' }, acceptedToken).catch(() => {});
      if (this.saved?.token === acceptedToken) await this.clearToken().catch(() => {});
      const publicCodes = new Set([
        'JR_ACCESS_BUSY',
        'JR_ACCESS_DEVICE_BOUND',
        'JR_ACCESS_INVALID_CODE',
        'JR_ACCESS_INVALID_RESPONSE',
        'JR_ACCESS_INVALID_MODEL',
        'JR_ACCESS_REVOKED',
        'JR_ACCESS_BLOCKED',
        'JR_ACCESS_OUTSIDE_HOURS',
        'JR_ACCESS_PROFILE_UNBOUND',
        'JR_ACCESS_STORAGE_UNAVAILABLE',
        'JR_ACCESS_UNAVAILABLE',
        'JR_ACCESS_RUNTIME_UNAVAILABLE',
      ]);
      const publicError = !stopped
        ? 'JR_ACCESS_RUNTIME_UNAVAILABLE'
        : error instanceof Error && publicCodes.has(error.message)
          ? error.message
          : 'JR_ACCESS_UNAVAILABLE';
      if (epoch === this.generation)
        this.publish(
          publicError === 'JR_ACCESS_BLOCKED'
            ? 'blocked'
            : publicError === 'JR_ACCESS_OUTSIDE_HOURS'
              ? 'outside-hours'
              : [
                    'JR_ACCESS_STORAGE_UNAVAILABLE',
                    'JR_ACCESS_PROFILE_UNBOUND',
                    'JR_ACCESS_RUNTIME_UNAVAILABLE',
                  ].includes(publicError)
                ? 'unconfigured'
                : publicError === 'JR_ACCESS_UNAVAILABLE'
                  ? 'offline'
                  : 'signed-out'
        );
      if (publicError !== 'JR_ACCESS_UNAVAILABLE') throw new Error(publicError);
      return fail('JR_ACCESS_UNAVAILABLE');
    } finally {
      this.authenticating = false;
    }
  }
  /**
   * Register the local JR MiniMax gateway again.
   * A restored session already passed login, so opening a bot and "Tentar novamente"
   * must be able to rewrite the provider without asking for the invite.
   */
  async ensureGateway(): Promise<void> {
    if (this.options.pilot) {
      await this.options.ensurePilot?.();
      return;
    }
    if (this.current.status !== 'authenticated' || !this.saved?.token || !this.options.url)
      return fail('JR_ACCESS_REQUIRED');
    await this.options.configureCore({
      url: `${this.options.url}/v1`,
      token: this.saved.token,
      model: 'MiniMax-M3.1-Flash',
    });
  }
  async logout(): Promise<JrAccessState> {
    return this.blockTransitions(async () => {
      this.generation += 1;
      const token = this.saved?.token;
      this.publish('signed-out');
      const stopped = await this.stopCore();
      let persisted = true;
      try {
        if (this.saved?.token === token) await this.clearToken();
      } catch {
        this.publish('unconfigured');
        persisted = false;
      }
      if (token) await this.remote('/auth/logout', { method: 'POST' }, token).catch(() => {});
      if (!persisted) return fail('JR_ACCESS_STORAGE_UNAVAILABLE');
      if (!stopped) return fail('JR_ACCESS_RUNTIME_UNAVAILABLE');
      return this.state;
    });
  }
  private async authorized(path: string, init: RequestInit = {}, admin = false): Promise<unknown> {
    if (this.current.status !== 'authenticated' || !this.saved?.token) return fail('JR_ACCESS_REQUIRED');
    if (admin && !isJrAdmin(this.current.user)) return fail('JR_ACCESS_FORBIDDEN');
    const epoch = this.generation,
      token = this.saved.token;
    let response: Response;
    try {
      response = await this.remote(path, init, token);
    } catch {
      if (epoch !== this.generation) return fail('JR_ACCESS_REQUIRED');
      await this.blockTransitions(async () => {
        this.publish('offline');
        await this.stopCore();
      });
      return fail('JR_ACCESS_UNAVAILABLE');
    }
    if (epoch !== this.generation || token !== this.saved?.token) return fail('JR_ACCESS_REQUIRED');
    if (response.status === 401) {
      await this.rejectSession(token);
      return fail('JR_ACCESS_REVOKED');
    }
    if (response.status === 403) {
      const restriction = restrictionStatus((await responseCode(response)) ?? '');
      if (restriction) {
        await this.applyRestriction(restriction, token);
        return fail(restriction === 'blocked' ? 'JR_ACCESS_BLOCKED' : 'JR_ACCESS_OUTSIDE_HOURS');
      }
      return fail('JR_ACCESS_FORBIDDEN');
    }
    if (response.status === 409) return fail('JR_ACCESS_EMPLOYEE_REVOKED');
    if (!response.ok) return fail('JR_ACCESS_UNAVAILABLE');
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      return fail('JR_ACCESS_INVALID_RESPONSE');
    }
    if (epoch !== this.generation || token !== this.saved?.token) return fail('JR_ACCESS_REQUIRED');
    return value;
  }
  async personalUsage(): Promise<JrConnectionStatus> {
    return parseJrConnectionStatus(await this.authorized('/usage'));
  }
  async listEmployees(): Promise<JrEmployee[]> {
    const value = await this.authorized('/admin/employees', {}, true);
    if (!record(value) || !Array.isArray(value.employees)) return fail('JR_ACCESS_INVALID_RESPONSE');
    return value.employees.map((entry) => {
      const user = parseUser(entry);
      if (
        !record(entry) ||
        typeof entry.revoked !== 'boolean' ||
        (entry.blocked !== undefined && typeof entry.blocked !== 'boolean') ||
        typeof entry.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(entry.createdAt)) ||
        (entry.revokedAt !== null &&
          (typeof entry.revokedAt !== 'string' || !Number.isFinite(Date.parse(entry.revokedAt)))) ||
        !Array.isArray(entry.devices)
      )
        return fail('JR_ACCESS_INVALID_RESPONSE');
      const devices = entry.devices.map((device) => {
        if (
          !record(device) ||
          !validId(device.id) ||
          typeof device.name !== 'string' ||
          typeof device.lastSeenAt !== 'string' ||
          typeof device.expiresAt !== 'string' ||
          (device.revokedAt !== null && typeof device.revokedAt !== 'string')
        )
          return fail('JR_ACCESS_INVALID_RESPONSE');
        return {
          id: device.id,
          name: device.name,
          lastSeenAt: device.lastSeenAt,
          expiresAt: device.expiresAt,
          revokedAt: device.revokedAt as string | null,
        };
      });
      const usage =
        entry.usage === null
          ? null
          : parseJrConnectionStatus({ model: record(entry.usage) ? entry.usage.model : null, usage: entry.usage })
              .usage;
      const email = listedEmail(entry.email);
      const title = listedTitle(entry.title);
      const tokenLimit =
        entry.tokenLimit == null ? null : typeof entry.tokenLimit === 'number' ? entry.tokenLimit : NaN;
      const accessStart =
        entry.accessStart == null ? null : validClock(entry.accessStart) ? entry.accessStart : undefined;
      const accessEnd = entry.accessEnd == null ? null : validClock(entry.accessEnd) ? entry.accessEnd : undefined;
      if (
        (tokenLimit !== null && (!Number.isSafeInteger(tokenLimit) || tokenLimit < 0)) ||
        accessStart === undefined ||
        accessEnd === undefined ||
        (accessStart === null) !== (accessEnd === null) ||
        (accessStart !== null && accessStart === accessEnd) ||
        (entry.blockedAt != null &&
          (typeof entry.blockedAt !== 'string' || !Number.isFinite(Date.parse(entry.blockedAt))))
      )
        return fail('JR_ACCESS_INVALID_RESPONSE');
      return {
        ...user,
        email,
        title,
        revoked: entry.revoked,
        createdAt: entry.createdAt,
        revokedAt: entry.revokedAt as string | null,
        blocked: entry.blocked === true,
        blockedAt: (entry.blockedAt as string | null | undefined) ?? null,
        tokenLimit,
        accessStart,
        accessEnd,
        devices,
        usage,
      };
    });
  }
  async createInvite(input: {
    name: string;
    email?: string | null;
    title?: string | null;
    tokenLimit?: number | null;
    accessStart?: string | null;
    accessEnd?: string | null;
  }): Promise<JrInvite> {
    if (typeof input?.name !== 'string' || !input.name.trim() || input.name.trim().length > 120)
      return fail('JR_ACCESS_INVALID_NAME');
    const email = inviteEmail(input.email);
    const title = inviteTitle(input.title);
    if (
      (input.tokenLimit != null && (!Number.isSafeInteger(input.tokenLimit) || input.tokenLimit < 0)) ||
      ((input.accessStart ?? null) === null) !== ((input.accessEnd ?? null) === null) ||
      (input.accessStart != null && !validClock(input.accessStart)) ||
      (input.accessEnd != null && !validClock(input.accessEnd)) ||
      (input.accessStart != null && input.accessStart === input.accessEnd)
    )
      return fail('JR_ACCESS_INVALID_POLICY');
    return this.parseInvite(
      await this.authorized(
        '/admin/invites',
        {
          method: 'POST',
          body: JSON.stringify({
            name: input.name.trim(),
            email,
            title,
            tokenLimit: input.tokenLimit ?? null,
            accessStart: input.accessStart ?? null,
            accessEnd: input.accessEnd ?? null,
          }),
        },
        true
      )
    );
  }
  private parseInvite(value: unknown): JrInvite {
    if (
      !record(value) ||
      !validId(value.id) ||
      typeof value.code !== 'string' ||
      value.code.length > 512 ||
      !value.code ||
      typeof value.expiresAt !== 'string'
    )
      return fail('JR_ACCESS_INVALID_RESPONSE');
    return { id: value.id, code: value.code, expiresAt: value.expiresAt };
  }
  async reissueInvite(input: { employeeId: string }): Promise<JrInvite> {
    if (!validId(input?.employeeId)) return fail('JR_ACCESS_INVALID_EMPLOYEE');
    return this.parseInvite(
      await this.authorized(`/admin/employees/${encodeURIComponent(input.employeeId)}/invite`, { method: 'POST' }, true)
    );
  }
  async revoke(input: { employeeId: string }): Promise<void> {
    if (!validId(input?.employeeId)) return fail('JR_ACCESS_INVALID_EMPLOYEE');
    const value = await this.authorized(
      `/admin/employees/${encodeURIComponent(input.employeeId)}/revoke`,
      { method: 'POST' },
      true
    );
    if (!record(value) || value.revoked !== true) return fail('JR_ACCESS_INVALID_RESPONSE');
  }
  async setBlocked(input: { employeeId: string; blocked: boolean }): Promise<{ blocked: boolean }> {
    if (!validId(input?.employeeId) || typeof input.blocked !== 'boolean') return fail('JR_ACCESS_INVALID_EMPLOYEE');
    const value = await this.authorized(
      `/admin/employees/${encodeURIComponent(input.employeeId)}/block`,
      { method: 'POST', body: JSON.stringify({ blocked: input.blocked }) },
      true
    );
    if (!record(value) || value.blocked !== input.blocked) return fail('JR_ACCESS_INVALID_RESPONSE');
    return { blocked: value.blocked };
  }
  async updatePolicy(input: {
    employeeId: string;
    tokenLimit: number | null;
    accessStart: string | null;
    accessEnd: string | null;
  }): Promise<{ tokenLimit: number | null; accessStart: string | null; accessEnd: string | null }> {
    if (
      !validId(input?.employeeId) ||
      (input.tokenLimit !== null && (!Number.isSafeInteger(input.tokenLimit) || input.tokenLimit < 0)) ||
      (input.accessStart === null) !== (input.accessEnd === null) ||
      (input.accessStart !== null && !validClock(input.accessStart)) ||
      (input.accessEnd !== null && !validClock(input.accessEnd)) ||
      (input.accessStart !== null && input.accessStart === input.accessEnd)
    )
      return fail('JR_ACCESS_INVALID_POLICY');
    const value = await this.authorized(
      `/admin/employees/${encodeURIComponent(input.employeeId)}/policy`,
      {
        method: 'POST',
        body: JSON.stringify({
          tokenLimit: input.tokenLimit,
          accessStart: input.accessStart,
          accessEnd: input.accessEnd,
        }),
      },
      true
    );
    if (
      !record(value) ||
      value.tokenLimit !== input.tokenLimit ||
      value.accessStart !== input.accessStart ||
      value.accessEnd !== input.accessEnd
    )
      return fail('JR_ACCESS_INVALID_RESPONSE');
    return { tokenLimit: value.tokenLimit, accessStart: value.accessStart, accessEnd: value.accessEnd };
  }
}

/** Map a control-service denial from the model proxy onto the local session. */
export function applyJrProxyDenial(
  controller: JrAccessController,
  token: string,
  notice: JrProxyDenial | undefined,
  onError: (error: unknown) => void = () => {}
): void {
  const action =
    notice?.status === 403 && notice.code === 'employee_blocked'
      ? controller.noteGatewayRestriction('blocked', token)
      : notice?.status === 403 && notice.code === 'outside_access_hours'
        ? controller.noteGatewayRestriction('outside-hours', token)
        : notice?.status === 401
          ? controller.rejectSession(token)
          : Promise.resolve(controller.state);
  void action.catch(onError);
}

let nativeController: JrAccessController | null = null;
/** Register the main-process controller before the first renderer opens. */
export function setJrAccessController(controller: JrAccessController): void {
  nativeController = controller;
}
/** Return native access capabilities without exposing session secrets over IPC. */
export function getJrAccessController(): JrAccessController {
  if (!nativeController) return fail('JR_ACCESS_UNCONFIGURED');
  return nativeController;
}
