'use strict';

const { hashPassword, passwordProblem } = require('./security/passwords');
const { generateSecret } = require('./security/totp');

const USERNAME_PATTERN = /^[a-zA-Z0-9._@-]{3,64}$/;

function totpAad(adminId) {
  return `admin-totp:${adminId}`;
}

/**
 * Creates an admin, or resets the password (and 2FA secret) of an existing one.
 * Returns the new TOTP secret when two-factor authentication is enabled.
 */
async function upsertAdmin(db, cryptoBox, { username, password, enableTotp = true }) {
  if (!USERNAME_PATTERN.test(username || '')) {
    throw new Error('Username must be 3-64 characters: letters, numbers, dot, dash, underscore or @.');
  }
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const passwordHash = await hashPassword(password);
  const totpSecret = enableTotp ? generateSecret() : null;

  let created = false;
  db.transaction(() => {
    const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
    let id;
    created = !existing;
    if (existing) {
      id = existing.id;
      db.prepare(
        'UPDATE admins SET password_hash = ?, failed_attempts = 0, locked_until = NULL, last_totp_step = NULL WHERE id = ?'
      ).run(passwordHash, id);
      db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(id);
    } else {
      id = db
        .prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
        .run(username, passwordHash, Date.now()).lastInsertRowid;
    }
    const totpEnc = totpSecret ? cryptoBox.encryptString(totpSecret, totpAad(id)) : null;
    db.prepare('UPDATE admins SET totp_secret_enc = ? WHERE id = ?').run(totpEnc, id);
  })();

  return { totpSecret, created };
}

module.exports = { upsertAdmin, totpAad, USERNAME_PATTERN };
