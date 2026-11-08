import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { httpError } from '../validation.mjs';

/** Separate tables in the existing control database; provider grants are encrypted per JR account. */
export function createStrataStore(databasePath, config, now) {
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS strata_links (
      user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, context_revision INTEGER NOT NULL DEFAULT 0, erp_user_id TEXT,
      display_name TEXT, organization_id TEXT, linked_at INTEGER, encrypted_grant TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS strata_erp_identity ON strata_links(erp_user_id) WHERE erp_user_id IS NOT NULL;`);
  if (
    !db
      .prepare('PRAGMA table_info(strata_links)')
      .all()
      .some((column) => column.name === 'context_revision')
  )
    db.exec('ALTER TABLE strata_links ADD COLUMN context_revision INTEGER NOT NULL DEFAULT 0');
  const aad = (userId) => Buffer.from(JSON.stringify([userId, config.issuer, config.clientId, config.resourceUrl]));
  const seal = (userId, value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', config.encryptionKey, iv);
    cipher.setAAD(aad(userId));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  };
  const open = (userId, value) => {
    try {
      const bytes = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', config.encryptionKey, bytes.subarray(0, 12));
      decipher.setAAD(aad(userId));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    } catch {
      throw httpError(409, 'strata_reconnect_required');
    }
  };
  const row = (userId) => db.prepare('SELECT * FROM strata_links WHERE user_id = ?').get(userId);
  const ensure = (userId) => db.prepare('INSERT OR IGNORE INTO strata_links(user_id) VALUES (?)').run(userId);
  return {
    begin(userId) {
      ensure(userId);
      db.prepare(
        'UPDATE strata_links SET revision = revision + 1, context_revision = context_revision + 1 WHERE user_id = ?'
      ).run(userId);
      return row(userId).revision;
    },
    get(userId) {
      const value = row(userId);
      return value ? { ...value, grant: value.encrypted_grant ? open(userId, value.encrypted_grant) : null } : null;
    },
    current(userId, revision, contextRevision) {
      const value = row(userId);
      return (
        value?.revision === revision && (contextRevision === undefined || value.context_revision === contextRevision)
      );
    },
    install(userId, revision, identity, grant) {
      try {
        const changed = db
          .prepare(
            'UPDATE strata_links SET erp_user_id = ?, display_name = ?, organization_id = ?, linked_at = ?, encrypted_grant = ? WHERE user_id = ? AND revision = ?'
          )
          .run(
            identity.id,
            identity.name,
            identity.organizationId,
            now(),
            seal(userId, grant),
            userId,
            revision
          ).changes;
        if (!changed) throw httpError(409, 'strata_link_changed');
      } catch (error) {
        if (String(error?.code).startsWith('ERR_SQLITE') || String(error?.message).includes('UNIQUE constraint'))
          throw httpError(409, 'strata_identity_already_linked');
        throw error;
      }
    },
    refresh(userId, revision, grant) {
      if (
        !db
          .prepare(
            'UPDATE strata_links SET encrypted_grant = ? WHERE user_id = ? AND revision = ? AND erp_user_id IS NOT NULL'
          )
          .run(seal(userId, grant), userId, revision).changes
      )
        throw httpError(409, 'strata_link_changed');
    },
    organization(userId, revision, organizationId) {
      if (
        !db
          .prepare(
            'UPDATE strata_links SET organization_id = ?, context_revision = context_revision + 1 WHERE user_id = ? AND revision = ?'
          )
          .run(organizationId, userId, revision).changes
      )
        throw httpError(409, 'strata_link_changed');
    },
    disconnect(userId) {
      ensure(userId);
      db.prepare(
        'UPDATE strata_links SET revision = revision + 1, context_revision = context_revision + 1, erp_user_id = NULL, display_name = NULL, organization_id = NULL, linked_at = NULL, encrypted_grant = NULL WHERE user_id = ?'
      ).run(userId);
    },
    close() {
      db.close();
    },
  };
}
