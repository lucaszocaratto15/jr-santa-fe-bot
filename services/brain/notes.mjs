import { createHash, randomUUID } from 'node:crypto';

const fail = (status, code) => Object.assign(new Error(code), { status, code });
const KINDS = new Set(['shared_note', 'official_procedure']);

/** Binds approval to the exact note text, authorized source, audience, kind and revision. */
export const proposalHash = (proposal) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        proposal.id,
        proposal.version,
        proposal.text,
        proposal.sourceQuote,
        proposal.areaId,
        proposal.kind,
        proposal.validFrom,
        proposal.validUntil,
      ])
    )
    .digest('hex');

export function createNotesStore({ db, companyId, now, insertFact, getFact }) {
  db.exec(`CREATE TABLE IF NOT EXISTS brain_proposals (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, author_user_id TEXT NOT NULL,
    request_id TEXT NOT NULL, request_hash TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL, source_quote TEXT NOT NULL,
    authorized_source TEXT NOT NULL, area_id INTEGER NOT NULL, risk TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, source_kind TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, consent_hash TEXT, consented_at INTEGER, fact_id INTEGER,
    reviewed_by TEXT, reviewed_at INTEGER, note_id TEXT NOT NULL, note_version INTEGER NOT NULL, supersedes_id INTEGER, valid_from INTEGER NOT NULL, valid_until INTEGER,
    UNIQUE(company_id, author_user_id, request_id)
  ); CREATE TABLE IF NOT EXISTS brain_diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, metadata TEXT NOT NULL
  );`);
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(brain_proposals)')
      .all()
      .map((column) => column.name)
  );
  for (const name of ['author_erp_user_id', 'reviewed_erp_user_id']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE brain_proposals ADD COLUMN ${name} TEXT`);
  }
  const row = (item) =>
    item
      ? {
          id: item.id,
          version: item.version,
          text: item.text,
          sourceQuote: item.source_quote,
          areaId: item.area_id,
          risk: item.risk,
          kind: item.kind,
          status: item.status,
          createdAt: item.created_at,
          factId: item.fact_id,
          reviewedBy: item.reviewed_by,
          reviewedAt: item.reviewed_at,
          noteId: item.note_id,
          noteVersion: item.note_version,
          supersedesId: item.supersedes_id,
          validFrom: item.valid_from,
          validUntil: item.valid_until,
        }
      : null;
  const getRaw = (id) => db.prepare('SELECT * FROM brain_proposals WHERE company_id = ? AND id = ?').get(companyId, id);
  const projection = (item) => {
    const value = row(item);
    return value ? { ...value, hash: proposalHash(value) } : null;
  };
  const transaction = (run) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const requireDraft = (id, userId, version, erpUserId) => {
    const item = getRaw(id);
    if (!item || item.author_user_id !== userId) throw fail(404, 'proposal_not_found');
    if (erpUserId !== undefined && item.author_erp_user_id !== erpUserId) throw fail(404, 'proposal_not_found');
    if (item.status !== 'draft' || item.version !== version) throw fail(409, 'version_conflict');
    return item;
  };
  return {
    diagnostics: {
      add(event) {
        db.prepare('INSERT INTO brain_diagnostics (company_id, metadata) VALUES (?, ?)').run(
          companyId,
          JSON.stringify(event)
        );
        db.prepare(
          'DELETE FROM brain_diagnostics WHERE company_id = ? AND id NOT IN (SELECT id FROM brain_diagnostics WHERE company_id = ? ORDER BY id DESC LIMIT 5000)'
        ).run(companyId, companyId);
      },
      list: () =>
        db
          .prepare('SELECT metadata FROM brain_diagnostics WHERE company_id = ? ORDER BY id DESC LIMIT 200')
          .all(companyId)
          .map((item) => JSON.parse(item.metadata)),
    },
    get: (id, userId, erpUserId) => {
      const item = getRaw(id);
      return item?.author_user_id === userId && (erpUserId === undefined || item.author_erp_user_id === erpUserId)
        ? projection(item)
        : null;
    },
    listOwn: (userId, erpUserId) =>
      db
        .prepare(
          `SELECT * FROM brain_proposals WHERE company_id = ? AND author_user_id = ? ${erpUserId === undefined ? '' : 'AND author_erp_user_id = ?'} ORDER BY created_at DESC LIMIT 100`
        )
        .all(companyId, userId, ...(erpUserId === undefined ? [] : [erpUserId]))
        .map(projection),
    byRequest(userId, requestId, hash, erpUserId) {
      const item = db
        .prepare('SELECT * FROM brain_proposals WHERE company_id = ? AND author_user_id = ? AND request_id = ?')
        .get(companyId, userId, requestId);
      if (item && item.request_hash !== hash) throw fail(409, 'idempotency_conflict');
      if (item && erpUserId !== undefined && item.author_erp_user_id !== erpUserId)
        throw fail(403, 'identity_mismatch');
      return projection(item);
    },
    create(userId, requestId, requestHash, candidate, authorizedSource, erpUserId = null) {
      const id = randomUUID();
      db.prepare(`INSERT INTO brain_proposals (id, company_id, author_user_id, request_id, request_hash, version,
        text, source_quote, authorized_source, area_id, risk, kind, status, source_kind, created_at, updated_at, note_id, note_version, supersedes_id, valid_from, valid_until, author_erp_user_id)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        companyId,
        userId,
        requestId,
        requestHash,
        candidate.text,
        candidate.sourceQuote,
        authorizedSource,
        candidate.areaId,
        candidate.risk,
        candidate.kind ?? 'shared_note',
        candidate.sourceKind,
        now(),
        now(),
        candidate.noteId ?? id,
        candidate.noteVersion ?? 1,
        candidate.supersedesId ?? null,
        candidate.validFrom ?? now(),
        candidate.validUntil ?? null,
        erpUserId
      );
      return projection(getRaw(id));
    },
    revise(id, userId, version, patch, erpUserId) {
      const item = requireDraft(id, userId, version, erpUserId);
      if (!KINDS.has(patch.kind) || !item.authorized_source.includes(patch.sourceQuote))
        throw fail(400, 'invalid_proposal');
      db.prepare(`UPDATE brain_proposals SET text = ?, source_quote = ?, area_id = ?, kind = ?, risk = ?,
        version = version + 1, valid_from = ?, valid_until = ?, updated_at = ? WHERE id = ? AND company_id = ?`).run(
        patch.text,
        patch.sourceQuote,
        patch.areaId,
        patch.kind,
        patch.risk,
        patch.validFrom,
        patch.validUntil,
        now(),
        id,
        companyId
      );
      return projection(getRaw(id));
    },
    consent(id, userId, version, hash, decision, erpUserId = null) {
      return transaction(() => {
        const item = getRaw(id);
        if (!item || item.author_user_id !== userId) throw fail(404, 'proposal_not_found');
        if (item.author_erp_user_id !== null && item.author_erp_user_id !== erpUserId)
          throw fail(403, 'identity_mismatch');
        const proposal = projection(item);
        if (item.version !== version || proposal.hash !== hash) throw fail(409, 'consent_mismatch');
        if (item.status !== 'draft') {
          if (item.consent_hash === hash && item.fact_id !== null && decision === 'share') {
            if (item.author_erp_user_id !== erpUserId) throw fail(403, 'identity_mismatch');
            return { proposal, fact: getFact(item.fact_id) };
          }
          throw fail(409, 'version_conflict');
        }
        const status =
          decision === 'discard' ? 'rejected' : item.kind === 'official_procedure' ? 'pending_review' : 'active';
        if (decision === 'share' && item.supersedes_id !== null) {
          const previous = getFact(item.supersedes_id);
          if (!previous || previous.status !== 'active' || previous.supersededBy !== null)
            throw fail(409, 'version_conflict');
        }
        let factId = null;
        if (decision === 'share')
          factId = insertFact({
            areaId: item.area_id,
            risk: item.risk,
            kind: 'fato',
            text: item.text,
            sourceQuote: item.source_quote,
            sourceKind: item.source_kind,
            authorUserId: userId,
            authorErpUserId: erpUserId,
            confidence: 6,
            noteId: item.note_id,
            noteType: item.kind,
            status,
            version: item.note_version,
            consentHash: hash,
            validFrom: item.valid_from,
            validUntil: item.valid_until,
          });
        if (status === 'active' && item.supersedes_id !== null)
          db.prepare(
            "UPDATE brain_facts SET status = 'superseded', superseded_by = ? WHERE company_id = ? AND id = ?"
          ).run(factId, companyId, item.supersedes_id);
        db.prepare(
          'UPDATE brain_proposals SET status = ?, consent_hash = ?, consented_at = ?, fact_id = ?, authorized_source = ?, author_erp_user_id = ? WHERE company_id = ? AND id = ?'
        ).run(
          status,
          hash,
          now(),
          factId,
          item.source_quote,
          item.author_erp_user_id ?? (decision === 'share' ? erpUserId : null),
          companyId,
          id
        );
        return { proposal: projection(getRaw(id)), ...(factId === null ? {} : { fact: getFact(factId) }) };
      });
    },
    pending(scope) {
      const low = [...scope.low];
      const high = [...scope.high];
      const marks = (values) => (values.length ? values.map(() => '?').join(',') : 'NULL');
      return db
        .prepare(`SELECT * FROM brain_proposals WHERE company_id = ? AND status = 'pending_review'
        ${scope.verified ? 'AND author_erp_user_id IS NOT NULL AND consent_hash IS NOT NULL' : ''}
        AND ((risk = 'low' AND area_id IN (${marks(low)})) OR (risk = 'high' AND area_id IN (${marks(high)})))
        ORDER BY created_at LIMIT 200`)
        .all(companyId, ...low, ...high)
        .map(projection);
    },
    review(id, version, byUserId, decision, canReview, erpUserId = null, verified = false) {
      return transaction(() => {
        const item = getRaw(id);
        if (!item || !canReview(item.area_id, item.risk)) throw fail(404, 'proposal_not_found');
        if (verified && (!item.author_erp_user_id || !item.consent_hash)) throw fail(404, 'proposal_not_found');
        if (item.supersedes_id !== null) {
          const source = getFact(item.supersedes_id);
          if (!source || !canReview(source.areaId, source.risk)) throw fail(404, 'proposal_not_found');
        }
        if (item.status !== 'pending_review' || item.version !== version) throw fail(409, 'version_conflict');
        const status = decision === 'approve' ? 'active' : 'rejected';
        if (decision === 'approve' && item.supersedes_id !== null) {
          const previous = getFact(item.supersedes_id);
          if (!previous || previous.status !== 'active' || previous.supersededBy !== null)
            throw fail(409, 'version_conflict');
          db.prepare(
            "UPDATE brain_facts SET status = 'superseded', superseded_by = ? WHERE company_id = ? AND id = ?"
          ).run(item.fact_id, companyId, item.supersedes_id);
        }
        db.prepare(
          'UPDATE brain_proposals SET status = ?, reviewed_by = ?, reviewed_at = ?, reviewed_erp_user_id = ? WHERE company_id = ? AND id = ?'
        ).run(status, byUserId, now(), erpUserId, companyId, id);
        db.prepare(
          'UPDATE brain_facts SET status = ?, active = ?, approved_by = ?, approved_at = ?, approved_erp_user_id = ? WHERE company_id = ? AND id = ?'
        ).run(
          status,
          Number(status === 'active'),
          decision === 'approve' ? byUserId : null,
          decision === 'approve' ? now() : null,
          decision === 'approve' ? erpUserId : null,
          companyId,
          item.fact_id
        );
        return { proposal: projection(getRaw(id)), fact: getFact(item.fact_id) };
      });
    },
  };
}
