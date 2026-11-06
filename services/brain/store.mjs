import { chmodSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canRead } from './access.mjs';
import { normalize } from './text.mjs';
import { createNotesStore } from './notes.mjs';

const DAY = 86_400_000;
const FULL_RECENCY_DAYS = 30;
const ZERO_RECENCY_DAYS = 730;
const DEFAULT_MIN_CONFIDENCE = 3;
const GENERAL_NAME = 'Geral';
const FALLBACK_NAME = 'Sem área';
const CANDIDATES = 200;

const fail = (status, code) => Object.assign(new Error(code), { status, code });

/** Recency factor: 1 for 30 days, linear down to 0 at 730 days. */
export function recencyFactor(ageMs) {
  const days = ageMs / DAY;
  if (days <= FULL_RECENCY_DAYS) return 1;
  if (days >= ZERO_RECENCY_DAYS) return 0;
  return (ZERO_RECENCY_DAYS - days) / (ZERO_RECENCY_DAYS - FULL_RECENCY_DAYS);
}

const factRow = (row, effective) => ({
  id: row.id,
  companyId: row.company_id,
  areaId: row.area_id,
  risk: row.risk,
  kind: row.kind,
  text: row.text,
  sourceQuote: row.source_quote,
  sourceKind: row.source_kind,
  authorUserId: row.author_user_id,
  authorErpUserId: row.author_erp_user_id,
  authorBot: row.author_bot,
  conversationRef: row.conversation_ref,
  erpRef: row.erp_ref,
  createdAt: row.created_at,
  confidence: row.confidence,
  supersededBy: row.superseded_by,
  active: row.active === 1,
  suspended: row.suspended === 1,
  flagConflict: row.flag_conflict === 1,
  humanEdited: row.human_edited === 1,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at,
  noteId: row.note_id,
  noteType: row.note_type,
  status: row.status,
  version: row.version,
  approvedBy: row.approved_by,
  approvedErpUserId: row.approved_erp_user_id,
  approvedAt: row.approved_at,
  validFrom: row.valid_from ?? row.created_at,
  validUntil: row.valid_until,
  ...(effective === undefined ? {} : { effectiveConfidence: effective }),
});

/** FTS5 query over normalized tokens: OR of quoted terms, prefix match from 3 characters. */
function ftsQuery(query) {
  const tokens = normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens)].map((token) => `"${token}"${token.length >= 3 ? '*' : ''}`).join(' OR ');
}

/** Open an organization-scoped database; private drafts contain only explicitly authorized excerpts. */
export function createBrainStore(dbPath, { now = Date.now, companyId = 'jr', dailyCuratorCalls = 500 } = {}) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS areas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, name TEXT NOT NULL,
      is_general INTEGER NOT NULL DEFAULT 0, UNIQUE (company_id, name)
    );
    CREATE TABLE IF NOT EXISTS user_areas (
      user_id TEXT NOT NULL, company_id TEXT NOT NULL, area_id INTEGER NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('colaborador', 'gestor')), is_primary INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, company_id, area_id)
    );
    CREATE TABLE IF NOT EXISTS brain_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, area_id INTEGER NOT NULL,
      risk TEXT NOT NULL CHECK (risk IN ('low', 'high')), kind TEXT NOT NULL,
      text TEXT NOT NULL, text_norm TEXT NOT NULL, source_quote TEXT,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('usuario_afirmou', 'bot_concluiu')),
      author_user_id TEXT NOT NULL, author_bot TEXT, conversation_ref TEXT, erp_ref TEXT,
      created_at INTEGER NOT NULL, confidence REAL NOT NULL, superseded_by INTEGER,
      active INTEGER NOT NULL DEFAULT 1, suspended INTEGER NOT NULL DEFAULT 0,
      flag_conflict INTEGER NOT NULL DEFAULT 0, human_edited INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT, updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS brain_facts_area ON brain_facts (company_id, area_id);
    CREATE INDEX IF NOT EXISTS brain_facts_author ON brain_facts (company_id, author_user_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS brain_facts_fts USING fts5(
      text_norm, content = 'brain_facts', content_rowid = 'id'
    );
    CREATE TRIGGER IF NOT EXISTS brain_facts_ai AFTER INSERT ON brain_facts BEGIN
      INSERT INTO brain_facts_fts (rowid, text_norm) VALUES (new.id, new.text_norm);
    END;
    CREATE TRIGGER IF NOT EXISTS brain_facts_ad AFTER DELETE ON brain_facts BEGIN
      INSERT INTO brain_facts_fts (brain_facts_fts, rowid, text_norm) VALUES ('delete', old.id, old.text_norm);
    END;
    CREATE TRIGGER IF NOT EXISTS brain_facts_au AFTER UPDATE OF text_norm ON brain_facts BEGIN
      INSERT INTO brain_facts_fts (brain_facts_fts, rowid, text_norm) VALUES ('delete', old.id, old.text_norm);
      INSERT INTO brain_facts_fts (rowid, text_norm) VALUES (new.id, new.text_norm);
    END;
    CREATE TABLE IF NOT EXISTS brain_feedback (
      fact_id INTEGER NOT NULL, company_id TEXT NOT NULL, user_id TEXT NOT NULL, vote TEXT NOT NULL, weight REAL NOT NULL, at INTEGER NOT NULL,
      UNIQUE (fact_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS brain_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, at INTEGER NOT NULL,
      user_id TEXT NOT NULL, action TEXT NOT NULL, fact_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS brain_budget (
      day TEXT NOT NULL, company_id TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, company_id)
    );
    CREATE TABLE IF NOT EXISTS brain_consent (
      user_id TEXT NOT NULL, company_id TEXT NOT NULL, version TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (user_id, company_id, version)
    );
  `);
  if (
    !db
      .prepare('PRAGMA table_info(brain_facts)')
      .all()
      .some((column) => column.name === 'human_edited')
  )
    db.exec('ALTER TABLE brain_facts ADD COLUMN human_edited INTEGER NOT NULL DEFAULT 0');
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(brain_facts)')
      .all()
      .map((column) => column.name)
  );
  for (const [name, definition] of Object.entries({
    note_id: 'TEXT',
    note_type: "TEXT NOT NULL DEFAULT 'shared_note'",
    status: "TEXT NOT NULL DEFAULT 'active'",
    version: 'INTEGER NOT NULL DEFAULT 1',
    consent_hash: 'TEXT',
    approved_by: 'TEXT',
    approved_at: 'INTEGER',
    valid_from: 'INTEGER',
    valid_until: 'INTEGER',
    author_erp_user_id: 'TEXT',
    approved_erp_user_id: 'TEXT',
  }))
    if (!columns.has(name)) db.exec(`ALTER TABLE brain_facts ADD COLUMN ${name} ${definition}`);
  const areaColumns = new Set(
    db
      .prepare('PRAGMA table_info(areas)')
      .all()
      .map((column) => column.name)
  );
  for (const name of ['erp_audience_key', 'erp_audience_label'])
    if (!areaColumns.has(name)) db.exec(`ALTER TABLE areas ADD COLUMN ${name} TEXT`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS areas_erp_audience ON areas (company_id, erp_audience_key)');
  for (const [name, isGeneral] of [
    [GENERAL_NAME, 1],
    [FALLBACK_NAME, 0],
  ]) {
    db.prepare('INSERT OR IGNORE INTO areas (company_id, name, is_general) VALUES (?, ?, ?)').run(
      companyId,
      name,
      isGeneral
    );
  }

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

  const area = (id) => db.prepare('SELECT * FROM areas WHERE company_id = ? AND id = ?').get(companyId, id);
  const areaRow = (row) => ({
    id: row.id,
    name: row.erp_audience_label ?? row.name,
    isGeneral: row.is_general === 1,
    ...(row.erp_audience_key ? { erpAudienceKey: row.erp_audience_key } : {}),
  });
  const fallbackAreaId = () =>
    db.prepare('SELECT id FROM areas WHERE company_id = ? AND name = ?').get(companyId, FALLBACK_NAME).id;
  const isProtected = (row) => row.is_general === 1 || row.name === FALLBACK_NAME;
  const cleanName = (name) => {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value || value.length > 80) throw fail(400, 'invalid_area');
    return value;
  };

  const feedbackPenalty = db.prepare(
    "SELECT COALESCE(SUM(weight), 0) AS penalty FROM brain_feedback WHERE company_id = ? AND fact_id = ? AND vote = 'errado'"
  );
  const effectiveConfidence = (row) => {
    const base = row.confidence * recencyFactor(now() - row.created_at);
    return base - feedbackPenalty.get(row.company_id, row.id).penalty;
  };

  /** SQL predicate and params restricting facts to what the scope may read. */
  const scopeFilter = (scope) => {
    const provenance = scope.verified
      ? `f.author_erp_user_id IS NOT NULL AND f.consent_hash IS NOT NULL AND f.note_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM areas a WHERE a.company_id = f.company_id AND a.id = f.area_id AND a.erp_audience_key IS NOT NULL)`
      : '1 = 1';
    if (scope.group) {
      const companies = scope.group.organizations.map((item) => item.id);
      const keys = [...scope.audienceKeys];
      if (!scope.verified || scope.all || !companies.length || companies.length > 20 || keys.length > 100)
        throw fail(403, 'authorization_failed');
      return {
        sql: `(${provenance}) AND f.company_id IN (${companies.map(() => '?').join(',')})
          AND EXISTS (SELECT 1 FROM areas a WHERE a.company_id = f.company_id AND a.id = f.area_id
            AND a.erp_audience_key IN (${keys.length ? keys.map(() => '?').join(',') : 'NULL'}))`,
        params: [...companies, ...keys],
      };
    }
    if (scope.all) return { sql: provenance, params: [] };
    const low = [...scope.low];
    const high = [...scope.high];
    const marks = (list) => (list.length ? list.map(() => '?').join(',') : 'NULL');
    return {
      sql: `(${provenance}) AND ((f.risk = 'low' AND f.area_id IN (${marks(low)})) OR (f.risk = 'high' AND f.area_id IN (${marks(high)})))`,
      params: [...low, ...high],
    };
  };

  const getFact = (id, scope, { acrossGroup = false } = {}) => {
    const filter = scope ? scopeFilter(scope) : { sql: '1 = 1', params: [] };
    const group = acrossGroup && scope?.group;
    const row = db
      .prepare(
        `SELECT f.* FROM brain_facts f WHERE ${group ? '1 = 1' : 'f.company_id = ?'} AND f.id = ? AND ${filter.sql}`
      )
      .get(...(group ? [] : [companyId]), id, ...filter.params);
    if (!row) return null;
    const fact = factRow(row);
    return scope && !scope.group && !canRead(scope, fact) ? null : fact;
  };

  /** Search exposes only the authorized excerpt and its source company, never the private conversation. */
  const publicFact = (row, effective) => ({
    id: row.id,
    companyId: row.company_id,
    text: row.text,
    kind: row.kind,
    area: row.area_label ?? area(row.area_id)?.name ?? null,
    risk: row.risk,
    date: new Date(row.created_at).toISOString().slice(0, 10),
    confidence: Math.round(effective * 10) / 10,
    erpRef: row.erp_ref,
    noteType: row.note_type,
    version: row.version,
    ...(row.consent_hash ? { sourceQuote: row.source_quote } : {}),
  });

  const checkFact = ({ text, confidence, areaId, risk }) => {
    if (typeof text !== 'string' || !text.trim()) throw fail(400, 'invalid_fact');
    if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 10)) throw fail(400, 'invalid_fact');
    const target = area(areaId);
    if (!target) throw fail(404, 'area_not_found');
    if (risk === 'high' && target.is_general === 1) throw fail(400, 'high_in_general');
  };

  const PATCHABLE = {
    text: 'text',
    risk: 'risk',
    kind: 'kind',
    areaId: 'area_id',
    erpRef: 'erp_ref',
    confidence: 'confidence',
    active: 'active',
    suspended: 'suspended',
    status: 'status',
  };

  const insertFact = (fact) => {
    checkFact(fact);
    const validFrom = fact.validFrom ?? now();
    if (
      !Number.isFinite(validFrom) ||
      (fact.validUntil != null && (!Number.isFinite(fact.validUntil) || fact.validUntil <= validFrom))
    )
      throw fail(400, 'invalid_validity');
    const result = db
      .prepare(
        `INSERT INTO brain_facts (company_id, area_id, risk, kind, text, text_norm, source_quote, source_kind,
           author_user_id, author_bot, conversation_ref, erp_ref, created_at, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        companyId,
        fact.areaId,
        fact.risk,
        fact.kind ?? 'fato',
        fact.text,
        normalize(fact.text),
        fact.sourceQuote ?? null,
        fact.sourceKind,
        fact.authorUserId,
        fact.authorBot ?? null,
        fact.conversationRef ?? null,
        fact.erpRef ?? null,
        now(),
        fact.confidence
      );
    const id = Number(result.lastInsertRowid);
    db.prepare(
      `UPDATE brain_facts SET note_id = ?, note_type = ?, status = ?, version = ?, consent_hash = ?, active = ?, valid_from = ?, valid_until = ?, author_erp_user_id = ? WHERE company_id = ? AND id = ?`
    ).run(
      fact.noteId ?? null,
      fact.noteType ?? 'shared_note',
      fact.status ?? 'active',
      fact.version ?? 1,
      fact.consentHash ?? null,
      Number(!fact.status || fact.status === 'active'),
      fact.validFrom ?? now(),
      fact.validUntil ?? null,
      fact.authorErpUserId ?? null,
      companyId,
      id
    );
    return id;
  };

  const prune = db.prepare('DELETE FROM brain_log WHERE company_id = ? AND at < ?');

  const notes = createNotesStore({ db, companyId, now, insertFact, getFact });
  return {
    companyId,
    notes,
    diagnostics: notes.diagnostics,
    close: () => db.close(),
    areas: {
      fallbackId: fallbackAreaId,
      /** ERP keys identify labels, never local grants. Existing JR areas are not adopted by name. */
      syncErpAudiences(audiences) {
        return transaction(() =>
          audiences.map((audience) => {
            const existing = db
              .prepare('SELECT * FROM areas WHERE company_id = ? AND erp_audience_key = ?')
              .get(companyId, audience.key);
            if (existing) {
              db.prepare('UPDATE areas SET erp_audience_label = ? WHERE company_id = ? AND id = ?').run(
                audience.label,
                companyId,
                existing.id
              );
              return { ...areaRow(existing), name: audience.label };
            }
            const created = db
              .prepare(
                'INSERT INTO areas (company_id, name, is_general, erp_audience_key, erp_audience_label) VALUES (?, ?, 0, ?, ?)'
              )
              .run(companyId, `erp:${audience.key}:${randomUUID()}`, audience.key, audience.label);
            return areaRow(area(Number(created.lastInsertRowid)));
          })
        );
      },
      list: () =>
        db
          .prepare('SELECT * FROM areas WHERE company_id = ? ORDER BY is_general DESC, name')
          .all(companyId)
          .map(areaRow),
      create(name) {
        const value = cleanName(name);
        try {
          const result = db
            .prepare('INSERT INTO areas (company_id, name, is_general) VALUES (?, ?, 0)')
            .run(companyId, value);
          return { id: Number(result.lastInsertRowid), name: value, isGeneral: false };
        } catch {
          throw fail(409, 'area_exists');
        }
      },
      rename(id, name) {
        const row = area(id);
        if (!row) throw fail(404, 'area_not_found');
        if (isProtected(row)) throw fail(400, 'area_protected');
        const value = cleanName(name);
        try {
          db.prepare('UPDATE areas SET name = ? WHERE company_id = ? AND id = ?').run(value, companyId, id);
        } catch {
          throw fail(409, 'area_exists');
        }
        return { id, name: value, isGeneral: false };
      },
      /** Removing an area moves its facts to the owner-only "Sem área" and drops its memberships. */
      remove(id) {
        const row = area(id);
        if (!row) throw fail(404, 'area_not_found');
        if (isProtected(row)) throw fail(400, 'area_protected');
        transaction(() => {
          // Facts go to the owner-only fallback area; members just lose the area (they keep Geral).
          db.prepare('UPDATE brain_facts SET area_id = ? WHERE company_id = ? AND area_id = ?').run(
            fallbackAreaId(),
            companyId,
            id
          );
          db.prepare('DELETE FROM user_areas WHERE company_id = ? AND area_id = ?').run(companyId, id);
          db.prepare('DELETE FROM areas WHERE company_id = ? AND id = ?').run(companyId, id);
        });
      },
    },
    members: {
      set(userId, memberships) {
        const primaries = memberships.filter((membership) => membership.primary).length;
        if (primaries > 1) throw fail(400, 'invalid_membership');
        transaction(() => {
          db.prepare('DELETE FROM user_areas WHERE company_id = ? AND user_id = ?').run(companyId, userId);
          for (const membership of memberships) {
            if (!area(membership.areaId)) throw fail(404, 'area_not_found');
            if (membership.areaId === fallbackAreaId()) throw fail(400, 'area_protected');
            if (membership.level !== 'colaborador' && membership.level !== 'gestor')
              throw fail(400, 'invalid_membership');
            db.prepare(
              'INSERT OR REPLACE INTO user_areas (user_id, company_id, area_id, level, is_primary) VALUES (?, ?, ?, ?, ?)'
            ).run(userId, companyId, membership.areaId, membership.level, membership.primary ? 1 : 0);
          }
        });
      },
      of: (userId) =>
        db
          .prepare('SELECT * FROM user_areas WHERE company_id = ? AND user_id = ? ORDER BY area_id')
          .all(companyId, userId)
          .map((row) => ({ areaId: row.area_id, level: row.level, primary: row.is_primary === 1 })),
      ofArea: (areaId) =>
        db
          .prepare('SELECT * FROM user_areas WHERE company_id = ? AND area_id = ? ORDER BY user_id')
          .all(companyId, areaId)
          .map((row) => ({ userId: row.user_id, level: row.level, primary: row.is_primary === 1 })),
    },
    facts: {
      insert: (fact) => transaction(() => insertFact(fact)),
      get: getFact,
      /** Ranked search over what `scope` may read; at most `limit` facts and `maxChars` of fact text. */
      search(scope, query, { limit = 5, maxChars = 1500, minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
        const match = ftsQuery(query);
        if (!match) return [];
        const filter = scopeFilter(scope);
        const rows = db
          .prepare(
            `SELECT f.*, COALESCE(a.erp_audience_label, a.name) AS area_label
             FROM brain_facts_fts JOIN brain_facts f ON f.id = brain_facts_fts.rowid
             JOIN areas a ON a.company_id = f.company_id AND a.id = f.area_id
             WHERE brain_facts_fts MATCH ? AND ${scope.group ? '1 = 1' : 'f.company_id = ?'} AND f.active = 1 AND f.suspended = 0
               AND f.superseded_by IS NULL AND f.status = 'active'
               ${scope.verified ? "AND (f.note_type <> 'official_procedure' OR f.approved_erp_user_id IS NOT NULL)" : ''}
               AND COALESCE(f.valid_from, f.created_at) <= ? AND (f.valid_until IS NULL OR f.valid_until > ?) AND ${filter.sql}
             ORDER BY bm25(brain_facts_fts), f.id LIMIT ?`
          )
          .all(match, ...(scope.group ? [] : [companyId]), now(), now(), ...filter.params, CANDIDATES);
        const result = [];
        let chars = 0;
        for (const row of rows) {
          const effective = effectiveConfidence(row);
          if (effective < minConfidence) continue;
          if (chars + row.text.length > maxChars) continue;
          result.push(publicFact(row, effective));
          chars += row.text.length;
          if (result.length >= limit) break;
        }
        return result;
      },
      /**
       * Trusted-server lookup for the curator: active, unsuperseded facts of one area and risk that share
       * words with `text`, best match first. Not scope-filtered and not a user-facing projection.
       */
      similar(areaId, risk, text, limit = 10, scope) {
        const match = ftsQuery(text);
        if (!match) return [];
        const filter = scope ? scopeFilter(scope) : { sql: '1 = 1', params: [] };
        return db
          .prepare(
            `SELECT f.* FROM brain_facts_fts JOIN brain_facts f ON f.id = brain_facts_fts.rowid
             WHERE brain_facts_fts MATCH ? AND f.company_id = ? AND f.area_id = ? AND f.risk = ?
               AND f.active = 1 AND f.suspended = 0 AND f.superseded_by IS NULL AND f.status = 'active' AND ${filter.sql}
             ORDER BY bm25(brain_facts_fts) LIMIT ?`
          )
          .all(match, companyId, areaId, risk, ...filter.params, limit)
          .map((row) => factRow(row));
      },
      update(id, patch, byUserId) {
        return transaction(() => {
          const current = getFact(id);
          if (!current) throw fail(404, 'fact_not_found');
          checkFact({
            text: patch.text ?? current.text,
            confidence: patch.confidence ?? current.confidence,
            areaId: patch.areaId ?? current.areaId,
            risk: patch.risk ?? current.risk,
          });
          const sets = [];
          const params = [];
          for (const [key, column] of Object.entries(PATCHABLE)) {
            if (patch[key] === undefined) continue;
            sets.push(`${column} = ?`);
            params.push(typeof patch[key] === 'boolean' ? Number(patch[key]) : patch[key]);
            if (key === 'text') {
              sets.push('text_norm = ?');
              params.push(normalize(patch.text));
            }
          }
          // `human_edited` marks any change by a person and is never cleared; the curator's own writes
          // (confidence bumps) neither set it nor overwrite a human's `updated_by`.
          const byCurator = byUserId === 'curator';
          if (!byCurator || current.updatedBy === null || current.updatedBy === 'curator') {
            sets.push('updated_by = ?', 'updated_at = ?');
            params.push(byUserId, now());
          }
          if (!byCurator) sets.push('human_edited = 1');
          db.prepare(`UPDATE brain_facts SET ${sets.join(', ')} WHERE company_id = ? AND id = ?`).run(
            ...params,
            companyId,
            id
          );
          return getFact(id);
        });
      },
      /** Insert `newFact` and retire `oldId` behind it; only within the same risk level. */
      supersede(oldId, newFact) {
        return transaction(() => {
          const old = getFact(oldId);
          if (!old) throw fail(404, 'fact_not_found');
          if (old.supersededBy !== null) throw fail(409, 'already_superseded');
          if (old.risk !== newFact.risk) throw fail(409, 'risk_mismatch');
          if (old.areaId !== newFact.areaId) throw fail(409, 'area_mismatch');
          const newId = insertFact(newFact);
          db.prepare(
            "UPDATE brain_facts SET superseded_by = ?, status = 'superseded' WHERE company_id = ? AND id = ?"
          ).run(newId, companyId, oldId);
          return newId;
        });
      },
      /** Cross-risk contradictions keep both facts; the gestor sees this flag. */
      flagConflict(id) {
        db.prepare('UPDATE brain_facts SET flag_conflict = 1 WHERE company_id = ? AND id = ?').run(companyId, id);
      },
      /** Facts the scope can read, including suspended and inactive ones (not superseded). */
      listForManager(scope, { areaId, risk, kind, suspended, q, flaggedOnly = false, limit = 200 } = {}) {
        const filter = scopeFilter(scope);
        const clauses = [filter.sql, 'f.company_id = ?', 'f.superseded_by IS NULL'];
        const params = [...filter.params, companyId];
        if (areaId !== undefined) {
          clauses.push('f.area_id = ?');
          params.push(areaId);
        }
        if (risk !== undefined) {
          clauses.push('f.risk = ?');
          params.push(risk);
        }
        if (kind !== undefined) {
          clauses.push('f.kind = ?');
          params.push(kind);
        }
        if (suspended !== undefined) {
          clauses.push('f.suspended = ?');
          params.push(suspended ? 1 : 0);
        }
        if (q) {
          clauses.push("f.text_norm LIKE ? ESCAPE '\\'");
          params.push(`%${normalize(q).replace(/[\\%_]/gu, (c) => `\\${c}`)}%`);
        }
        if (flaggedOnly) clauses.push('(f.flag_conflict = 1 OR f.suspended = 1)');
        return db
          .prepare(`SELECT f.* FROM brain_facts f WHERE ${clauses.join(' AND ')} ORDER BY f.id DESC LIMIT ?`)
          .all(...params, Math.min(Math.max(1, limit), 200))
          .map((row) => factRow(row, effectiveConfidence(row)));
      },
      /** The supersession chain a fact belongs to, oldest first. */
      history(id, scope) {
        const seen = new Map();
        const queue = [id];
        while (queue.length) {
          const current = queue.pop();
          if (seen.has(current)) continue;
          const fact = getFact(current, scope);
          if (!fact) continue;
          seen.set(current, fact);
          if (fact.supersededBy !== null) queue.push(fact.supersededBy);
          for (const row of db
            .prepare('SELECT id FROM brain_facts WHERE company_id = ? AND superseded_by = ?')
            .all(companyId, current))
            queue.push(row.id);
        }
        if (scope && (!seen.has(id) || !canRead(scope, seen.get(id)))) return [];
        return [...seen.values()]
          .filter((fact) => !scope || canRead(scope, fact))
          .toSorted((a, b) => a.createdAt - b.createdAt || a.id - b.id);
      },
      /** Remove every fact an author wrote (right to be forgotten); returns how many. */
      deleteByAuthor(userId) {
        return transaction(() => {
          const ids = db
            .prepare('SELECT id FROM brain_facts WHERE company_id = ? AND author_user_id = ?')
            .all(companyId, userId)
            .map((row) => row.id);
          for (const id of ids) {
            db.prepare(
              "UPDATE brain_facts SET superseded_by = NULL, status = CASE WHEN note_id IS NULL THEN 'active' ELSE status END WHERE company_id = ? AND superseded_by = ?"
            ).run(companyId, id);
            db.prepare('DELETE FROM brain_feedback WHERE company_id = ? AND fact_id = ?').run(companyId, id);
            db.prepare('DELETE FROM brain_facts WHERE id = ?').run(id);
          }
          db.prepare('DELETE FROM brain_proposals WHERE company_id = ? AND author_user_id = ?').run(companyId, userId);
          return ids.length;
        });
      },
    },
    feedback: {
      /** One vote per user per fact; a new vote replaces the previous one. `weight` is in confidence points. */
      vote(factId, userId, weight, vote = 'errado') {
        if (!getFact(factId)) throw fail(404, 'fact_not_found');
        const clamped = Number.isFinite(weight) ? Math.max(0, weight) : 0;
        db.prepare(
          `INSERT INTO brain_feedback (fact_id, company_id, user_id, vote, weight, at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (fact_id, user_id) DO UPDATE SET vote = excluded.vote, weight = excluded.weight, at = excluded.at`
        ).run(factId, companyId, userId, vote, clamped, now());
      },
    },
    log: {
      add: ({ userId, action, factId = null }) => {
        db.prepare('INSERT INTO brain_log (company_id, at, user_id, action, fact_id) VALUES (?, ?, ?, ?, ?)').run(
          companyId,
          now(),
          userId,
          action,
          factId
        );
      },
      /** Oldest first by default; with `limit`, the newest `limit` rows, newest first. */
      list: ({ since = 0, limit } = {}) =>
        db
          .prepare(
            `SELECT * FROM brain_log WHERE company_id = ? AND at >= ? ORDER BY id ${limit ? 'DESC LIMIT ?' : ''}`
          )
          .all(companyId, since, ...(limit ? [limit] : []))
          .map((row) => ({ id: row.id, at: row.at, userId: row.user_id, action: row.action, factId: row.fact_id })),
      prune: (days = 90) => Number(prune.run(companyId, now() - days * DAY).changes),
    },
    budget: {
      /** Spend one curator call for `day`; false once the daily budget is used up. */
      take: (day) =>
        transaction(() => {
          db.prepare('INSERT OR IGNORE INTO brain_budget (day, company_id, used) VALUES (?, ?, 0)').run(day, companyId);
          const { used } = db
            .prepare('SELECT used FROM brain_budget WHERE day = ? AND company_id = ?')
            .get(day, companyId);
          if (used >= dailyCuratorCalls) return false;
          db.prepare('UPDATE brain_budget SET used = used + 1 WHERE day = ? AND company_id = ?').run(day, companyId);
          return true;
        }),
    },
    consent: {
      record(userId, version) {
        db.prepare(
          `INSERT INTO brain_consent (user_id, company_id, version, at) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, company_id, version) DO UPDATE SET at = excluded.at`
        ).run(userId, companyId, version, now());
      },
      latest(userId) {
        const row = db
          .prepare(
            'SELECT version, at FROM brain_consent WHERE company_id = ? AND user_id = ? ORDER BY at DESC, rowid DESC LIMIT 1'
          )
          .get(companyId, userId);
        return row ? { version: row.version, at: row.at } : null;
      },
    },
  };
}
