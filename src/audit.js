'use strict';

/**
 * Records who did what. Entries reference records by ID only, never by
 * applicant name or email, so the log itself holds no applicant personal data.
 */
function audit(db, { adminId = null, action, target = null, ip = null }) {
  db.prepare('INSERT INTO audit_log (admin_id, action, target, ip, created_at) VALUES (?, ?, ?, ?, ?)').run(
    adminId,
    action,
    target,
    ip,
    Date.now()
  );
}

module.exports = { audit };
