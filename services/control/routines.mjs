import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { httpError, textField } from './validation.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const ROUTINE_TTL_MS = 24 * DAY;
export const ROUTINE_RATE_LIMIT = 30;
export const ROUTINE_RATE_WINDOW_MS = HOUR;
export const ROUTINE_MAX_PER_USER = 10;
export const ROUTINE_PAYLOAD_LIMIT = 64 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CRON_JOB_RE = /^[A-Za-z0-9._:-]{1,128}$/u;
const CONVERSATION_RE = /^[A-Za-z0-9._:-]{1,128}$/u;

const hashSecret = (value) => createHash('sha256').update(value).digest();
const keyHex = (value) => hashSecret(value).toString('hex');
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

/** Create routine and trigger tables. Secrets are stored only as SHA-256 hashes. */
export function migrateRoutines(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      instructions TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      cron_job_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      secret_hash BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      last_run_at INTEGER,
      UNIQUE (user_id, cron_job_id)
    );
    CREATE INDEX IF NOT EXISTS routines_user ON routines(user_id, created_at);
    CREATE TABLE IF NOT EXISTS routine_triggers (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      delivered_at INTEGER,
      acked_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'expired', 'failed', 'discarded'))
    );
    CREATE INDEX IF NOT EXISTS routine_triggers_pending ON routine_triggers(user_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS routine_triggers_routine ON routine_triggers(routine_id, created_at);
  `);
}

function publicRoutine(row) {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    conversationId: row.conversation_id,
    cronJobId: row.cron_job_id,
    enabled: row.enabled === 1,
    createdAt: iso(row.created_at),
    lastRunAt: iso(row.last_run_at),
  };
}

function publicTrigger(row) {
  let payload = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }
  return {
    id: row.id,
    routineId: row.routine_id,
    cronJobId: row.cron_job_id,
    conversationId: row.conversation_id,
    instructions: row.instructions,
    name: row.name,
    payload,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  };
}

function expirePending(db, timestamp) {
  db.prepare(
    `UPDATE routine_triggers SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= ?`
  ).run(timestamp);
}

/** Build the routines store bound to the shared SQLite database. */
export function createRoutineStore({ db, now = Date.now, publicBaseUrl = '' }) {
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

  const webhookUrl = (id, secret) => {
    const base = typeof publicBaseUrl === 'string' ? publicBaseUrl.replace(/\/$/u, '') : '';
    const path = `/routines/${id}/webhook/${secret}`;
    return base ? `${base}${path}` : path;
  };

  return {
    create(userId, input) {
      const name = textField(input.name, 1, 80);
      const instructions = textField(input.instructions, 1, 4000);
      const conversationId = textField(input.conversationId, 1, 128);
      const cronJobId = textField(input.cronJobId, 1, 128);
      if (!CONVERSATION_RE.test(conversationId) || !CRON_JOB_RE.test(cronJobId))
        throw httpError(400, 'invalid_request');
      return transaction(() => {
        const count = db.prepare('SELECT COUNT(*) AS total FROM routines WHERE user_id = ?').get(userId).total;
        if (count >= ROUTINE_MAX_PER_USER) throw httpError(409, 'routine_limit');
        const existing = db
          .prepare('SELECT id FROM routines WHERE user_id = ? AND cron_job_id = ?')
          .get(userId, cronJobId);
        if (existing) throw httpError(409, 'routine_exists');
        const id = randomUUID();
        const secret = randomBytes(32).toString('base64url');
        const timestamp = now();
        db.prepare(
          `INSERT INTO routines
            (id,user_id,name,instructions,conversation_id,cron_job_id,enabled,secret_hash,created_at)
           VALUES (?,?,?,?,?,?,1,?,?)`
        ).run(id, userId, name, instructions, conversationId, cronJobId, hashSecret(secret), timestamp);
        return {
          ...publicRoutine({
            id,
            name,
            instructions,
            conversation_id: conversationId,
            cron_job_id: cronJobId,
            enabled: 1,
            created_at: timestamp,
            last_run_at: null,
          }),
          webhookUrl: webhookUrl(id, secret),
          webhookSecret: secret,
        };
      });
    },

    list(userId) {
      return db
        .prepare('SELECT * FROM routines WHERE user_id = ? ORDER BY created_at DESC')
        .all(userId)
        .map(publicRoutine);
    },

    setEnabled(userId, id, enabled) {
      if (!ID_RE.test(id) || typeof enabled !== 'boolean') throw httpError(400, 'invalid_request');
      return transaction(() => {
        const row = db.prepare('SELECT * FROM routines WHERE id = ? AND user_id = ?').get(id, userId);
        if (!row) throw httpError(404, 'not_found');
        db.prepare('UPDATE routines SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
        return { ...publicRoutine(row), enabled };
      });
    },

    remove(userId, id) {
      if (!ID_RE.test(id)) throw httpError(400, 'invalid_request');
      return transaction(() => {
        const row = db.prepare('SELECT id FROM routines WHERE id = ? AND user_id = ?').get(id, userId);
        if (!row) throw httpError(404, 'not_found');
        db.prepare('DELETE FROM routines WHERE id = ?').run(id);
        return { deleted: true };
      });
    },

    /** Public webhook ingress. Wrong secret → 404 with no leak. */
    enqueueWebhook(id, secret, payload) {
      if (!ID_RE.test(id) || typeof secret !== 'string' || !/^[a-zA-Z0-9_-]{43}$/u.test(secret))
        throw httpError(404, 'not_found');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw httpError(400, 'invalid_request');
      const encoded = JSON.stringify(payload);
      if (Buffer.byteLength(encoded) > ROUTINE_PAYLOAD_LIMIT) throw httpError(413, 'request_too_large');
      return transaction(() => {
        const timestamp = now();
        expirePending(db, timestamp);
        const row = db
          .prepare(
            `SELECT routines.*, users.revoked_at AS user_revoked, users.blocked_at AS user_blocked
             FROM routines JOIN users ON users.id = routines.user_id
             WHERE routines.id = ?`
          )
          .get(id);
        if (!row || row.user_revoked !== null || row.user_blocked !== null || row.enabled !== 1)
          throw httpError(404, 'not_found');
        const expected = Buffer.from(row.secret_hash);
        const actual = hashSecret(secret);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw httpError(404, 'not_found');
        const recent = db
          .prepare(
            `SELECT COUNT(*) AS total FROM routine_triggers
             WHERE routine_id = ? AND created_at >= ?`
          )
          .get(id, timestamp - ROUTINE_RATE_WINDOW_MS).total;
        if (recent >= ROUTINE_RATE_LIMIT) throw httpError(429, 'rate_limited');
        const triggerId = randomUUID();
        db.prepare(
          `INSERT INTO routine_triggers
            (id,routine_id,user_id,payload_hash,payload_json,created_at,expires_at,status)
           VALUES (?,?,?,?,?,?,?,'pending')`
        ).run(triggerId, id, row.user_id, keyHex(encoded), encoded, timestamp, timestamp + ROUTINE_TTL_MS);
        return { accepted: true, triggerId, expiresAt: iso(timestamp + ROUTINE_TTL_MS) };
      });
    },

    pending(userId) {
      return transaction(() => {
        const timestamp = now();
        expirePending(db, timestamp);
        return db
          .prepare(
            `SELECT routine_triggers.*, routines.cron_job_id, routines.conversation_id,
                    routines.instructions, routines.name
             FROM routine_triggers
             JOIN routines ON routines.id = routine_triggers.routine_id
             WHERE routine_triggers.user_id = ? AND routine_triggers.status = 'pending'
               AND routines.enabled = 1
             ORDER BY routine_triggers.created_at ASC
             LIMIT 20`
          )
          .all(userId)
          .map(publicTrigger);
      });
    },

    ack(userId, routineId, triggerId, outcome = 'delivered') {
      if (!ID_RE.test(routineId) || !ID_RE.test(triggerId)) throw httpError(400, 'invalid_request');
      if (!['delivered', 'failed', 'discarded'].includes(outcome)) throw httpError(400, 'invalid_request');
      return transaction(() => {
        const timestamp = now();
        expirePending(db, timestamp);
        const row = db
          .prepare(
            `SELECT * FROM routine_triggers
             WHERE id = ? AND routine_id = ? AND user_id = ?`
          )
          .get(triggerId, routineId, userId);
        if (!row) throw httpError(404, 'not_found');
        if (row.status !== 'pending') return { status: row.status };
        db.prepare(
          `UPDATE routine_triggers
           SET status = ?, delivered_at = ?, acked_at = ?
           WHERE id = ?`
        ).run(outcome, timestamp, timestamp, triggerId);
        if (outcome === 'delivered') {
          db.prepare('UPDATE routines SET last_run_at = ? WHERE id = ? AND user_id = ?').run(
            timestamp,
            routineId,
            userId
          );
        }
        return { status: outcome };
      });
    },

    history(userId, routineId) {
      if (!ID_RE.test(routineId)) throw httpError(400, 'invalid_request');
      const routine = db.prepare('SELECT id FROM routines WHERE id = ? AND user_id = ?').get(routineId, userId);
      if (!routine) throw httpError(404, 'not_found');
      expirePending(db, now());
      return db
        .prepare(
          `SELECT id, status, created_at, delivered_at, expires_at
           FROM routine_triggers WHERE routine_id = ? AND user_id = ?
           ORDER BY created_at DESC LIMIT 50`
        )
        .all(routineId, userId)
        .map((row) => ({
          id: row.id,
          status: row.status,
          createdAt: iso(row.created_at),
          deliveredAt: iso(row.delivered_at),
          expiresAt: iso(row.expires_at),
        }));
    },

    /** Drop undelivered work when the employee is revoked or blocked. */
    discardForUser(userId) {
      db.prepare(
        `UPDATE routine_triggers SET status = 'discarded', acked_at = ?
         WHERE user_id = ? AND status = 'pending'`
      ).run(now(), userId);
      db.prepare('UPDATE routines SET enabled = 0 WHERE user_id = ?').run(userId);
    },
  };
}

/** Route handler for /routines*. Returns true when the path was handled. */
export async function handleRoutines({
  request,
  response,
  path,
  session,
  store,
  readJson,
  json,
  httpError: httpErr,
  reauth,
}) {
  if (!path?.startsWith('/routines')) return false;

  const publicWebhook = /^\/routines\/([0-9a-f-]{36})\/webhook\/([a-zA-Z0-9_-]{43})$/u.exec(path);
  if (request.method === 'POST' && publicWebhook) {
    const body = await readJson(request, ROUTINE_PAYLOAD_LIMIT);
    return json(response, 202, store.enqueueWebhook(publicWebhook[1], publicWebhook[2], body));
  }

  if (!session?.user?.id) throw httpErr(401, 'invalid_session');

  if (request.method === 'GET' && path === '/routines')
    return json(response, 200, { routines: store.list(session.user.id) });
  if (request.method === 'POST' && path === '/routines') {
    const body = await readJson(request, 16_384);
    reauth?.(request);
    return json(response, 201, store.create(session.user.id, body));
  }
  if (request.method === 'GET' && path === '/routines/disparos')
    return json(response, 200, { triggers: store.pending(session.user.id) });

  const enable = /^\/routines\/([0-9a-f-]{36})\/(enable|disable)$/u.exec(path);
  if (request.method === 'POST' && enable) {
    await readJson(request, 1024);
    reauth?.(request);
    return json(response, 200, store.setEnabled(session.user.id, enable[1], enable[2] === 'enable'));
  }

  const history = /^\/routines\/([0-9a-f-]{36})\/history$/u.exec(path);
  if (request.method === 'GET' && history)
    return json(response, 200, { history: store.history(session.user.id, history[1]) });

  const ack = /^\/routines\/([0-9a-f-]{36})\/disparos\/([0-9a-f-]{36})\/ack$/u.exec(path);
  if (request.method === 'POST' && ack) {
    const body = await readJson(request, 1024);
    reauth?.(request);
    return json(
      response,
      200,
      store.ack(session.user.id, ack[1], ack[2], typeof body.outcome === 'string' ? body.outcome : 'delivered')
    );
  }

  const remove = /^\/routines\/([0-9a-f-]{36})$/u.exec(path);
  if (request.method === 'DELETE' && remove) {
    return json(response, 200, store.remove(session.user.id, remove[1]));
  }

  throw httpErr(404, 'not_found');
}
