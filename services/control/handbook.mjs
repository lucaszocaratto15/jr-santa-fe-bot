import { textField } from './validation.mjs';

const DAY = 86_400_000;
const INDICATOR_WINDOW_MS = 28 * DAY;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MEDIA = 40;
const MAX_MEDIA_BYTES = 300 * 1024;
export const HANDBOOK_REQUEST_LIMIT = 16 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/u;
const KINDS = new Set(['activity', 'indicators']);
const SOURCES = new Set(['taught', 'learn']);

/** Normalize a job title into the key that groups handbook items: no accents, lower case, single spaces. */
export function roleKey(title) {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, ' ');
}

/** Create the handbook tables. Items keep the role they were published under. */
export function migrateHandbook(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS handbook_items (
      id TEXT PRIMARY KEY, role_key TEXT NOT NULL, role_title TEXT NOT NULL,
      author_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('activity','indicators')),
      source TEXT NOT NULL CHECK (source IN ('taught','learn')),
      body TEXT NOT NULL, approved_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS handbook_items_role ON handbook_items(role_key);
    CREATE TABLE IF NOT EXISTS handbook_media (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES handbook_items(id) ON DELETE CASCADE,
      mime TEXT NOT NULL, data BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS handbook_media_item ON handbook_media(item_id);
  `);
}

const finiteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const round1 = (value) => Math.round(value * 10) / 10;

/** Add one author's values to a running per-key sum. */
function addToSum(map, key, label, values) {
  const entry = map.get(key) ?? { label, sums: values.map(() => 0), count: 0 };
  values.forEach((value, index) => {
    entry.sums[index] += value;
  });
  entry.count += 1;
  map.set(key, entry);
}

/** Average each author's latest indicators item (rows come oldest first) per activity and per app. Never returns per-person values. */
function aggregateIndicators(rows) {
  const latest = new Map();
  for (const row of rows) {
    latest.set(row.author_id, row);
  }
  if (latest.size === 0) return null;
  const activities = new Map();
  const apps = new Map();
  for (const row of latest.values()) {
    let body;
    try {
      body = JSON.parse(row.body);
    } catch {
      continue;
    }
    for (const activity of Array.isArray(body?.activities) ? body.activities : []) {
      const times = finiteNumber(activity?.timesPerWeek);
      const minutes = finiteNumber(activity?.minutesPerRun);
      if (typeof activity?.title !== 'string' || !activity.title.trim() || times === null || minutes === null) continue;
      addToSum(activities, roleKey(activity.title), activity.title.trim(), [times, minutes]);
    }
    for (const app of Array.isArray(body?.timePerApp) ? body.timePerApp : []) {
      const minutes = finiteNumber(app?.minutesPerDay);
      if (typeof app?.app !== 'string' || !app.app.trim() || minutes === null) continue;
      addToSum(apps, roleKey(app.app), app.app.trim(), [minutes]);
    }
  }
  return {
    activities: [...activities.values()].map((entry) => ({
      title: entry.label,
      timesPerWeek: round1(entry.sums[0] / entry.count),
      minutesPerRun: round1(entry.sums[1] / entry.count),
    })),
    timePerApp: [...apps.values()].map((entry) => ({
      app: entry.label,
      minutesPerDay: round1(entry.sums[0] / entry.count),
    })),
    contributors: latest.size,
  };
}

/** Decode and check one JPEG; throws the public error code on a bad or oversized image. */
function decodeJpeg(value, httpError) {
  if (typeof value !== 'string' || value.length === 0 || !BASE64_RE.test(value))
    throw httpError(400, 'invalid_request');
  if (Math.floor((value.length * 3) / 4) > MAX_MEDIA_BYTES + 3) throw httpError(413, 'too_large');
  const data = Buffer.from(value, 'base64');
  if (data.length > MAX_MEDIA_BYTES) throw httpError(413, 'too_large');
  if (data.length < 3 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff)
    throw httpError(400, 'invalid_request');
  return data;
}

/** Validate a publish request. Ids are client-made UUIDs so an item can be updated in place. */
function parsePublish(input, httpError) {
  if (!input || typeof input !== 'object') throw httpError(400, 'invalid_request');
  const { id, kind, source, body, media } = input;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw httpError(400, 'invalid_request');
  if (!KINDS.has(kind) || !SOURCES.has(source)) throw httpError(400, 'invalid_request');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'invalid_request');
  const bodyText = JSON.stringify(body);
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) throw httpError(413, 'too_large');
  if (!Array.isArray(media)) throw httpError(400, 'invalid_request');
  if (media.length > MAX_MEDIA) throw httpError(413, 'too_large');
  const seen = new Set();
  const decoded = media.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !ID_RE.test(entry.id))
      throw httpError(400, 'invalid_request');
    if (seen.has(entry.id)) throw httpError(400, 'invalid_request');
    seen.add(entry.id);
    return { id: entry.id, data: decodeJpeg(entry.base64, httpError) };
  });
  return { id, kind, source, bodyText, media: decoded };
}

/** Handbook persistence over the control database. Author ids never leave this module. */
export function createHandbookStore(db, now, httpError) {
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
  const userTitle = (userId) => {
    const row = db.prepare('SELECT title FROM users WHERE id = ?').get(userId);
    return typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : null;
  };
  const payloadFor = (key, title) => {
    const items = db
      .prepare("SELECT * FROM handbook_items WHERE role_key = ? AND kind = 'activity' ORDER BY approved_at, id")
      .all(key)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        source: row.source,
        body: JSON.parse(row.body),
        approvedAt: row.approved_at,
        updatedAt: row.updated_at,
        media: db
          .prepare('SELECT id FROM handbook_media WHERE item_id = ? ORDER BY rowid')
          .all(row.id)
          .map((media) => media.id),
      }));
    const indicators = aggregateIndicators(
      db
        .prepare(
          "SELECT author_id, body, updated_at FROM handbook_items WHERE role_key = ? AND kind = 'indicators' AND updated_at >= ? ORDER BY updated_at, rowid"
        )
        .all(key, now() - INDICATOR_WINDOW_MS)
    );
    return { role: { key, title }, items, indicators };
  };
  const latestTitle = (key) =>
    db.prepare('SELECT role_title FROM handbook_items WHERE role_key = ? ORDER BY updated_at DESC, id LIMIT 1').get(key)
      ?.role_title ?? null;
  return {
    mine(userId) {
      const title = userTitle(userId);
      if (!title) return { role: null, items: [], indicators: null };
      return payloadFor(roleKey(title), title);
    },
    forRole(key) {
      const title = latestTitle(key);
      if (!title) throw httpError(404, 'not_found');
      return payloadFor(key, title);
    },
    roles() {
      return db
        .prepare(
          `SELECT role_key AS key, SUM(CASE WHEN kind = 'activity' THEN 1 ELSE 0 END) AS activities,
          MAX(updated_at) AS updated FROM handbook_items GROUP BY role_key ORDER BY role_key`
        )
        .all()
        .map((row) => ({
          key: row.key,
          title: latestTitle(row.key),
          activities: row.activities,
          updatedAt: row.updated,
        }));
    },
    publish(userId, input) {
      const parsed = parsePublish(input, httpError);
      return transaction(() => {
        const timestamp = now();
        const existing = db.prepare('SELECT * FROM handbook_items WHERE id = ?').get(parsed.id);
        if (existing && existing.author_id !== userId) throw httpError(403, 'forbidden');
        if (existing && (existing.kind !== parsed.kind || existing.source !== parsed.source))
          throw httpError(400, 'invalid_request');
        for (const media of parsed.media) {
          const owner = db.prepare('SELECT item_id FROM handbook_media WHERE id = ?').get(media.id);
          if (owner && owner.item_id !== parsed.id) throw httpError(403, 'forbidden');
        }
        if (existing) {
          db.prepare('UPDATE handbook_items SET body = ?, updated_at = ? WHERE id = ?').run(
            parsed.bodyText,
            timestamp,
            parsed.id
          );
        } else {
          const title = userTitle(userId);
          if (!title) throw httpError(409, 'no_role');
          db.prepare(
            `INSERT INTO handbook_items (id,role_key,role_title,author_id,kind,source,body,approved_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)`
          ).run(
            parsed.id,
            roleKey(title),
            title,
            userId,
            parsed.kind,
            parsed.source,
            parsed.bodyText,
            timestamp,
            timestamp
          );
        }
        db.prepare('DELETE FROM handbook_media WHERE item_id = ?').run(parsed.id);
        const insert = db.prepare("INSERT INTO handbook_media (id,item_id,mime,data) VALUES (?,?,'image/jpeg',?)");
        for (const media of parsed.media) insert.run(media.id, parsed.id, media.data);
        return { id: parsed.id };
      });
    },
    remove(userId, id) {
      return transaction(() => {
        const existing = db.prepare('SELECT author_id FROM handbook_items WHERE id = ?').get(id);
        if (!existing) throw httpError(404, 'not_found');
        if (existing.author_id !== userId) throw httpError(403, 'forbidden');
        db.prepare('DELETE FROM handbook_items WHERE id = ?').run(id);
        return { removed: true };
      });
    },
    withdrawLearn(userId) {
      const result = db.prepare("DELETE FROM handbook_items WHERE author_id = ? AND source = 'learn'").run(userId);
      return { removed: Number(result.changes) };
    },
    media(userId, mediaId, isAdmin) {
      const row = db
        .prepare(
          `SELECT handbook_media.mime AS mime, handbook_media.data AS data, handbook_items.role_key AS role_key
          FROM handbook_media JOIN handbook_items ON handbook_items.id = handbook_media.item_id WHERE handbook_media.id = ?`
        )
        .get(mediaId);
      if (!row) throw httpError(404, 'not_found');
      if (!isAdmin) {
        const title = userTitle(userId);
        if (!title || roleKey(title) !== row.role_key) throw httpError(403, 'forbidden');
      }
      return { mime: row.mime, base64: Buffer.from(row.data).toString('base64') };
    },
  };
}

/**
 * Route `/handbook/*` and `/admin/handbook/*`. Returns true when the request was handled.
 * Admins only read: there is no admin write route and no approval queue.
 */
export async function handleHandbook({ request, response, path, session, store, readJson, json, httpError, reauth }) {
  if (!path) return false;
  const isAdmin = session.user.role === 'admin';
  const userId = session.user.id;
  if (path === '/admin/handbook/roles' || path.startsWith('/admin/handbook/')) {
    if (!isAdmin) throw httpError(403, 'forbidden');
    if (request.method !== 'GET') throw httpError(404, 'not_found');
    if (path === '/admin/handbook/roles') {
      json(response, 200, { roles: store.roles() });
      return true;
    }
    const match = /^\/admin\/handbook\/roles\/([^/]{1,240})$/u.exec(path);
    if (!match) throw httpError(404, 'not_found');
    let key;
    try {
      key = textField(decodeURIComponent(match[1]), 1, 120);
    } catch {
      throw httpError(400, 'invalid_request');
    }
    json(response, 200, store.forRole(key));
    return true;
  }
  if (!path.startsWith('/handbook/')) return false;
  if (request.method === 'GET' && path === '/handbook/mine') {
    json(response, 200, store.mine(userId));
    return true;
  }
  if (request.method === 'POST' && path === '/handbook/items') {
    const body = await readJson(request, HANDBOOK_REQUEST_LIMIT);
    reauth?.(request);
    json(response, 200, store.publish(userId, body));
    return true;
  }
  if (request.method === 'POST' && path === '/handbook/withdraw-learn') {
    json(response, 200, store.withdrawLearn(userId));
    return true;
  }
  const item = /^\/handbook\/items\/([0-9a-f-]{36})$/u.exec(path);
  if (request.method === 'DELETE' && item) {
    json(response, 200, store.remove(userId, item[1]));
    return true;
  }
  const media = /^\/handbook\/media\/([0-9a-f-]{36})$/u.exec(path);
  if (request.method === 'GET' && media) {
    json(response, 200, store.media(userId, media[1], isAdmin));
    return true;
  }
  throw httpError(404, 'not_found');
}
