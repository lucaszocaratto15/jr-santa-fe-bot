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

/** Optional job title shown on the admin list. Blank values are stored as null. */
function optionalTitle(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw httpError(400, 'invalid_request');
  const title = value.trim();
  if (!title) return null;
  if (
    title.length > 80 ||
    [...title].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw httpError(400, 'invalid_request');
  }
  return title;
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
  const maxDevices = value.maxDevices ?? 1;
  if (!Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 5) throw httpError(400, 'invalid_policy');
  return { tokenLimit, accessStart, accessEnd, maxDevices };
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
export const HISTORY_DAYS = 30;
const PEAK_PERIOD_DAYS = [1, 7, 30];
// ponytail: fixed São Paulo offset; Brazil has had no daylight saving since 2019.
const LOCAL_OFFSET_MS = -3 * 60 * 60 * 1000;

/**
 * Daily totals and the busiest rolling 5-hour window for the last HISTORY_DAYS local days.
 * `rows` are `{ at, tokens }` sorted by `at`; `tokens` is null when the provider sent no counts.
 */
export function usageHistory(rows, timestamp) {
  const local = timestamp + LOCAL_OFFSET_MS;
  const todayStart = timestamp - (((local % DAY) + DAY) % DAY);
  const since = todayStart - (HISTORY_DAYS - 1) * DAY;
  const daily = Array.from({ length: HISTORY_DAYS }, (_, index) => ({
    date: new Date(since + index * DAY + LOCAL_OFFSET_MS).toISOString().slice(0, 10),
    tokens: 0,
    requests: 0,
  }));
  const recent = rows.filter((row) => row.at >= since && row.at <= timestamp);
  for (const row of recent) {
    const day = daily[Math.floor((row.at - since) / DAY)];
    day.requests += 1;
    day.tokens += row.tokens ?? 0;
  }
  const peak5h = PEAK_PERIOD_DAYS.map((days) => {
    const metered = recent.filter((row) => row.tokens !== null && row.at >= todayStart - (days - 1) * DAY);
    let best = { tokens: 0, startedAt: null };
    let sum = 0;
    let end = 0;
    for (const row of metered) {
      while (end < metered.length && metered[end].at < row.at + FIVE_HOURS_MS) sum += metered[end++].tokens;
      if (sum > best.tokens) best = { tokens: sum, startedAt: new Date(row.at).toISOString() };
      sum -= row.tokens;
    }
    return { days, ...best };
  });
  return { daily, peak5h };
}

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
    ['title', 'TEXT'],
  ]) {
    if (!userColumns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
  if (!userColumns.has('max_devices')) {
    db.exec('ALTER TABLE users ADD COLUMN max_devices INTEGER NOT NULL DEFAULT 1');
    db.prepare("UPDATE users SET max_devices = 2 WHERE name = 'Bruno Yanes' AND max_devices = 1").run();
  }
  const sessionColumns = new Set(
    db
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((column) => column.name)
  );
  if (!sessionColumns.has('revoked_reason')) db.exec('ALTER TABLE sessions ADD COLUMN revoked_reason TEXT');
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
    const history = usageHistory(
      db
        .prepare(
          `SELECT started_at AS at, CASE WHEN prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL
          THEN prompt_tokens + completion_tokens END AS tokens
          FROM requests WHERE user_id = ? AND started_at >= ? ORDER BY started_at`
        )
        .all(userId, timestamp - (HISTORY_DAYS + 1) * DAY),
      timestamp
    );
    return {
      ...history,
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
        let handover = false;
        if (employeeId && user.id !== employeeId) {
          const previous = db.prepare('SELECT revoked_at FROM users WHERE id = ?').get(employeeId);
          const usedDevice =
            previous?.revoked_at != null &&
            db.prepare('SELECT 1 FROM sessions WHERE user_id = ? AND device_id = ? LIMIT 1').get(employeeId, deviceId);
          if (!usedDevice) throw httpError(403, 'device_bound_to_other_employee');
          handover = true;
        }
        if (user.blocked_at !== null) throw httpError(403, 'employee_blocked');
        if (!isWithinAccessHours(user.access_start, user.access_end, timestamp))
          throw httpError(403, 'outside_access_hours');
        if (!isOwner) db.prepare('UPDATE invites SET used_at = ? WHERE hash = ?').run(timestamp, user.invite_hash);
        const replacedSessions = [];
        if (!isOwner) {
          const active = 'user_id = ? AND revoked_at IS NULL AND expires_at > ?';
          const evictDevice = (device) => {
            const rows = db
              .prepare(`SELECT hash FROM sessions WHERE ${active} AND device_id = ?`)
              .all(user.id, timestamp, device);
            for (const row of rows) {
              db.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = 'replaced' WHERE hash = ?").run(
                timestamp,
                row.hash
              );
              replacedSessions.push(row.hash);
            }
          };
          evictDevice(deviceId);
          for (;;) {
            const devices = db
              .prepare(
                `SELECT device_id, MAX(last_seen_at) AS seen FROM sessions WHERE ${active} GROUP BY device_id ORDER BY seen, device_id`
              )
              .all(user.id, timestamp);
            if (devices.length < user.max_devices) break;
            evictDevice(devices[0].device_id);
          }
        }
        const token = randomBytes(32).toString('base64url');
        db.prepare(
          'INSERT INTO sessions (hash,user_id,device_id,device_name,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?,?)'
        ).run(keyHash(token), user.id, deviceId, deviceName, timestamp, timestamp, timestamp + 30 * DAY);
        return { token, user: publicUser(user), replacedSessions, ...(handover ? { handover: true } : {}) };
      });
    },
    session(token) {
      if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/u.test(token)) return null;
      const sessionHash = keyHash(token);
      const replaced = db
        .prepare("SELECT 1 FROM sessions WHERE hash = ? AND revoked_at IS NOT NULL AND revoked_reason = 'replaced'")
        .get(sessionHash);
      if (replaced) return { denied: 'session_replaced' };
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
      db.prepare(
        "UPDATE sessions SET revoked_at = ?, revoked_reason = 'logout' WHERE hash = ? AND revoked_at IS NULL"
      ).run(now(), sessionHash);
    },
    disconnectDevice(userId, deviceId) {
      return transaction(() => {
        const rows = db
          .prepare('SELECT hash FROM sessions WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL')
          .all(userId, deviceId);
        for (const row of rows)
          db.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = 'admin' WHERE hash = ?").run(
            now(),
            row.hash
          );
        return rows.map((row) => row.hash);
      });
    },
    invite(name, input = {}) {
      const policy = validatePolicy(input);
      const email = optionalEmail(input.email);
      const title = optionalTitle(input.title);
      return transaction(() => {
        const id = randomUUID();
        db.prepare(`INSERT INTO users (id,name,role,created_at,token_limit,access_start,access_end,email,title,max_devices)
          VALUES (?,?,'employee',?,?,?,?,?,?,?)`).run(
          id,
          name,
          now(),
          policy.tokenLimit,
          policy.accessStart,
          policy.accessEnd,
          email,
          title,
          policy.maxDevices
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
        db.prepare(
          "UPDATE sessions SET revoked_at = COALESCE(revoked_at,?), revoked_reason = COALESCE(revoked_reason,'revoked') WHERE user_id = ?"
        ).run(timestamp, id);
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
        // An update that does not mention maxDevices keeps the stored value instead of resetting it.
        const maxDevices = input?.maxDevices === undefined ? user.max_devices : policy.maxDevices;
        db.prepare(
          'UPDATE users SET token_limit = ?, access_start = ?, access_end = ?, max_devices = ? WHERE id = ?'
        ).run(policy.tokenLimit, policy.accessStart, policy.accessEnd, maxDevices, id);
        return { ...policy, maxDevices };
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
          title: row.title ?? null,
          tokenLimit: row.token_limit,
          accessStart: row.access_start,
          accessEnd: row.access_end,
          maxDevices: row.max_devices,
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
