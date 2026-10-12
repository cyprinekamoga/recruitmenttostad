'use strict';

const { audit } = require('./audit');
const { deleteApplication } = require('./records');

const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_LOG_DAYS = 365;

/**
 * Housekeeping that keeps the amount of stored personal data to a minimum:
 * - deletes applications (and their CVs and references) once the retention period has passed
 * - removes expired sessions and old audit entries
 * - marks unanswered reference links as expired
 * - removes encrypted files that no longer belong to any application
 */
function runMaintenance({ db, config, fileStore, logger = console, now = Date.now() }) {
  let purged = 0;
  if (config.retentionDays > 0) {
    const cutoff = now - config.retentionDays * DAY_MS;
    const expired = db.prepare('SELECT id FROM applications WHERE updated_at < ?').pluck().all(cutoff);
    for (const id of expired) {
      if (deleteApplication(db, fileStore, id)) purged++;
    }
    if (purged > 0) {
      audit(db, { action: 'retention.purge', target: `${purged} application(s)` });
      logger.info?.(`[maintenance] deleted ${purged} application(s) past the ${config.retentionDays}-day retention period`);
    }
  }

  db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(now, now - config.sessionIdleMs);
  db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(now - AUDIT_LOG_DAYS * DAY_MS);
  db.prepare(`UPDATE reference_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`).run(now);

  const knownFiles = new Set(db.prepare('SELECT id FROM files').pluck().all());
  const orphans = fileStore.removeOrphans(knownFiles);
  if (orphans > 0) logger.info?.(`[maintenance] removed ${orphans} orphaned upload(s)`);

  // Fold the write-ahead log back into the (secure-delete) main database file.
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { purged, orphans };
}

module.exports = { runMaintenance };
