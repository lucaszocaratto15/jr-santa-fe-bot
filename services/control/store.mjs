import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { httpError } from './validation.mjs';

const DAY = 86_400_000;
const ACCESS_TIME_ZONE = 'America/Sao_Paulo';
const hash = (value) => createHash('sha256').update(value).digest();
const keyHash = (value) => hash(value).toString('hex');
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());
const publicUser = (row) => ({ id: row.id, name: row.name, role: row.id === 'owner' ? 'admin' : row.role });

function optionalEmail(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw httpError(400, 'invalid_request');
  const email = value.trim();
  if (!email) return null;
  if (
    email.length > 120 ||
    [...email].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    throw httpError(400, 'invalid_request');
  }
  return email;
}

function clockMinutes(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function validatePolicy(value = {}) {
  const tokenLimit = value.tokenLimit ?? null;
  const accessStart = value.accessStart ?? null;
  const accessEnd = value.accessEnd ?? null;
  if (tokenLimit !== null && (!Number.isSafeInteger(tokenLimit) || tokenLimit < 0))
    throw httpError(400, 'invalid_policy');
  if (
    (accessStart === null) !== (accessEnd === null) ||
    (accessStart !== null && clockMinutes(accessStart) === null) ||
    (accessEnd !== null && clockMinutes(accessEnd) === null) ||
    (accessStart !== null && accessStart === accessEnd)
  ) {
    throw httpError(400, 'invalid_policy');
  }
  return { tokenLimit, accessStart, accessEnd };
}

function isWithinAccessHours(start, end, timestamp) {
  if (start === null || end === null) return true;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ACCESS_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const current = Number(values.hour) * 60 + Number(values.minute);
  const lower = clockMinutes(start);
  const upper = clockMinutes(end);
  return lower < upper ? current >= lower && current < upper : current >= lower || current < upper;
}

/**
 * Usage is reported only. The token_limit column and tokenPolicy() stay so a
 * later decision can turn enforcement back on without a schema change.
 */
export const TOKEN_LIMITS_ENFORCED = false;

/** Shown for the owner. A role word such as "Administrador" is not a person's name. */
const OWNER_PROFILE_NAME = 'Lucas Zocaratto';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Open the private control database; only hashes and aggregate usage are persisted. */
export function createStore({ databasePath, adminCode, model, now = Date.now }) {
  if (databasePath !== ':memory:' && (typeof databasePath !== 'string' || !isAbsolute(databasePath)))
    throw new Error('invalid_configuration');
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
      created_at INTEGER NOT NULL, revoked_at INTEGER, blocked_at INTEGER,
      token_limit INTEGER, access_start TEXT, access_end TEXT
    );
    CREATE TABLE IF NOT EXISTS invites (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), device_id TEXT NOT NULL, device_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), started_at INTEGER NOT NULL, finished_at INTEGER,
      first_byte_ms INTEGER, status TEXT NOT NULL, upstream_status INTEGER,
      prompt_tokens INTEGER, completion_tokens INTEGER, cached_prompt_tokens INTEGER
    );
    CREATE INDEX IF NOT EXISTS requests_user ON requests(user_id, started_at);
  `);
  const userColumns = new Set(
    db
      .prepare('PRAGMA table_info(users)')
      .all()
      .map((column) => column.name)
  );
  for (const [name, type] of [
    ['blocked_at', 'INTEGER'],
    ['token_limit', 'INTEGER'],
    ['access_start', 'TEXT'],
    ['access_end', 'TEXT'],
    ['email', 'TEXT'],
  ]) {
    if (!userColumns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
  db.prepare("INSERT OR IGNORE INTO users (id,name,role,created_at) VALUES ('owner',?,'admin',?)").run(
    OWNER_PROFILE_NAME,
    now()
  );
  db.prepare("UPDATE users SET role = 'admin' WHERE id = 'owner'").run();
  db.prepare(
    "UPDATE users SET name = ? WHERE id = 'owner' AND lower(trim(name)) IN ('administrador', 'administrator', 'admin')"
  ).run(OWNER_PROFILE_NAME);
  const ownerHash = hash(adminCode);
  const transaction = (action) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const issueInvite = (userId) => {
    const code = `JR-${randomBytes(24).toString('base64url')}`;
    const expiresAt = now() + 7 * DAY;
    db.prepare('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL').run(userId);
    db.prepare('INSERT INTO invites (hash,user_id,expires_at) VALUES (?,?,?)').run(keyHash(code), userId, expiresAt);
    return { id: userId, code, expiresAt: iso(expiresAt) };
  };
  const windowTokens = (sum, unmetered) => (unmetered > 0 && sum == null ? null : (sum ?? 0));
  const usageFor = (userId) => {
    const timestamp = now();
    const since5h = timestamp - FIVE_HOURS_MS;
    const sinceWeek = timestamp - WEEK_MS;
    const row = db
      .prepare(`SELECT COUNT(*) AS requests, MIN(started_at) AS first_request, MAX(started_at) AS last_request,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL THEN 1 ELSE 0 END) AS metered,
      SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion, SUM(cached_prompt_tokens) AS cached,
      AVG(CASE WHEN finished_at IS NOT NULL THEN MAX(0, finished_at-started_at) END) AS latency,
      AVG(first_byte_ms) AS first_byte,
      SUM(CASE WHEN started_at >= ? AND prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL
        THEN prompt_tokens + completion_tokens END) AS tokens_5h,
      SUM(CASE WHEN started_at >= ? AND (prompt_tokens IS NULL OR completion_tokens IS NULL) THEN 1 ELSE 0 END) AS unmetered_5h,
      SUM(CASE WHEN started_at >= ? AND prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL
        THEN prompt_tokens + completion_tokens END) AS tokens_week,
      SUM(CASE WHEN started_at >= ? AND (prompt_tokens IS NULL OR completion_tokens IS NULL) THEN 1 ELSE 0 END) AS unmetered_week
      FROM requests WHERE user_id = ?`)
      .get(since5h, since5h, sinceWeek, sinceWeek, userId);
    if (row.requests === 0) return null;
    return {
      startedAt: iso(row.first_request),
      model,
      modelRequests: row.requests,
      requests: row.requests,
      completedRequests: row.completed,
      meteredRequests: row.metered,
      unmeteredRequests: row.requests - row.metered,
      promptTokens: row.prompt,
      completionTokens: row.completion,
      totalTokens:
        row.metered === row.requests && row.prompt !== null && row.completion !== null
          ? row.prompt + row.completion
          : null,
      tokensLast5h: windowTokens(row.tokens_5h, row.unmetered_5h),
      tokensThisWeek: windowTokens(row.tokens_week, row.unmetered_week),
      cachedPromptTokens: row.cached,
      averageLatencyMs: row.latency === null ? null : Math.round(row.latency),
      averageFirstByteMs: row.first_byte === null ? null : Math.round(row.first_byte),
      lastRequestAt: iso(row.last_request),
    };
  };
  return {
    login({ code, deviceId, deviceName, employeeId }) {
      return transaction(() => {
        const timestamp = now();
        let user;
        const isOwner = timingSafeEqual(hash(code), ownerHash);
        if (isOwner) {
          user = db.prepare("SELECT * FROM users WHERE id = 'owner'").get();
        } else {
          user = db
            .prepare(`SELECT users.*, invites.hash AS invite_hash FROM invites JOIN users ON users.id = invites.user_id
            WHERE invites.hash = ? AND invites.used_at IS NULL AND invites.expires_at > ? AND users.revoked_at IS NULL`)
            .get(keyHash(code), timestamp);
        }
        if (!user) throw httpError(401, 'invalid_credentials');
        if (employeeId && user.id !== employeeId) throw httpError(403, 'device_bound_to_other_employee');
        if (user.blocked_at !== null) throw httpError(403, 'employee_blocked');
        if (!isWithinAccessHours(user.access_start, user.access_end, timestamp))
          throw httpError(403, 'outside_access_hours');
        if (!isOwner) db.prepare('UPDATE invites SET used_at = ? WHERE hash = ?').run(timestamp, user.invite_hash);
        const token = randomBytes(32).toString('base64url');
        db.prepare(
          'INSERT INTO sessions (hash,user_id,device_id,device_name,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?,?)'
        ).run(keyHash(token), user.id, deviceId, deviceName, timestamp, timestamp, timestamp + 30 * DAY);
        return { token, user: publicUser(user) };
      });
    },
    session(token) {
      if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/u.test(token)) return null;
      const sessionHash = keyHash(token);
      const user = db
        .prepare(`SELECT users.*, sessions.hash AS session_hash FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.hash = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > ? AND users.revoked_at IS NULL`)
        .get(sessionHash, now());
      if (!user) return null;
      if (user.blocked_at !== null) return { denied: 'employee_blocked' };
      if (!isWithinAccessHours(user.access_start, user.access_end, now())) return { denied: 'outside_access_hours' };
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE hash = ?').run(now(), sessionHash);
      return { user: publicUser(user), sessionHash: user.session_hash };
    },
    logout(sessionHash) {
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE hash = ?').run(now(), sessionHash);
    },
    invite(name, input = {}) {
      const policy = validatePolicy(input);
      const email = optionalEmail(input.email);
      return transaction(() => {
        const id = randomUUID();
        db.prepare(`INSERT INTO users (id,name,role,created_at,token_limit,access_start,access_end,email)
          VALUES (?,?,'employee',?,?,?,?,?)`).run(
          id,
          name,
          now(),
          policy.tokenLimit,
          policy.accessStart,
          policy.accessEnd,
          email
        );
        return issueInvite(id);
      });
    },
    renewInvite(id) {
      return transaction(() => {
        const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'employee'").get(id);
        if (!user) throw httpError(404, 'not_found');
        if (user.revoked_at !== null) throw httpError(409, 'employee_revoked');
        return issueInvite(id);
      });
    },
    revoke(id) {
      return transaction(() => {
        const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'employee'").get(id);
        if (!user) throw httpError(404, 'not_found');
        const timestamp = now();
        db.prepare('UPDATE users SET revoked_at = COALESCE(revoked_at,?) WHERE id = ?').run(timestamp, id);
        db.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at,?) WHERE user_id = ?').run(timestamp, id);
        db.prepare('DELETE FROM invites WHERE user_id = ?').run(id);
      });
    },
    setBlocked(id, blocked) {
      if (typeof blocked !== 'boolean') throw httpError(400, 'invalid_request');
      return transaction(() => {
        const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'employee'").get(id);
        if (!user) throw httpError(404, 'not_found');
        if (user.revoked_at !== null) throw httpError(409, 'employee_revoked');
        const blockedAt = blocked ? (user.blocked_at ?? now()) : null;
        db.prepare('UPDATE users SET blocked_at = ? WHERE id = ?').run(blockedAt, id);
        return { blocked };
      });
    },
    updatePolicy(id, input) {
      const policy = validatePolicy(input);
      return transaction(() => {
        const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'employee'").get(id);
        if (!user) throw httpError(404, 'not_found');
        if (user.revoked_at !== null) throw httpError(409, 'employee_revoked');
        db.prepare('UPDATE users SET token_limit = ?, access_start = ?, access_end = ? WHERE id = ?').run(
          policy.tokenLimit,
          policy.accessStart,
          policy.accessEnd,
          id
        );
        return policy;
      });
    },
    tokenPolicy(userId) {
      if (!TOKEN_LIMITS_ENFORCED) return null;
      const row = db.prepare('SELECT token_limit FROM users WHERE id = ?').get(userId);
      if (!row || row.token_limit === null) return null;
      const usage = usageFor(userId);
      const used = usage?.totalTokens ?? 0;
      return {
        limit: row.token_limit,
        used,
        remaining: Math.max(0, row.token_limit - used),
        unmeteredRequests: usage?.unmeteredRequests ?? 0,
      };
    },
    employees() {
      return db
        .prepare("SELECT * FROM users WHERE role = 'employee' ORDER BY created_at,id")
        .all()
        .map((row) => ({
          ...publicUser(row),
          createdAt: iso(row.created_at),
          revoked: row.revoked_at !== null,
          revokedAt: iso(row.revoked_at),
          blocked: row.blocked_at !== null,
          blockedAt: iso(row.blocked_at),
          email: row.email ?? null,
          tokenLimit: row.token_limit,
          accessStart: row.access_start,
          accessEnd: row.access_end,
          devices: db
            .prepare(
              'SELECT device_id,device_name,last_seen_at,expires_at,revoked_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC'
            )
            .all(row.id)
            .map((device) => ({
              id: device.device_id,
              name: device.device_name,
              lastSeenAt: iso(device.last_seen_at),
              expiresAt: iso(device.expires_at),
              revokedAt: iso(device.revoked_at),
            })),
          usage: usageFor(row.id),
        }));
    },
    usage: usageFor,
    beginRequest(userId) {
      const id = randomUUID();
      db.prepare("INSERT INTO requests (id,user_id,started_at,status) VALUES (?,?,?,'pending')").run(id, userId, now());
      return id;
    },
    finishRequest(id, { status, usage, firstByteMs, upstreamStatus }) {
      db.prepare(
        'UPDATE requests SET finished_at=?,status=?,first_byte_ms=?,upstream_status=?,prompt_tokens=?,completion_tokens=?,cached_prompt_tokens=? WHERE id=?'
      ).run(
        now(),
        status,
        firstByteMs ?? null,
        upstreamStatus ?? null,
        usage?.promptTokens ?? null,
        usage?.completionTokens ?? null,
        usage?.cachedPromptTokens ?? null,
        id
      );
    },
    close() {
      db.close();
    },
  };
}
