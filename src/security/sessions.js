'use strict';

const { randomToken, sha256Hex } = require('../crypto');

const TOUCH_INTERVAL_MS = 60 * 1000;

function cookieName(config) {
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure,
  // host-only and scoped to "/", which blocks subdomain cookie injection.
  return config.secureCookies ? '__Host-session' : 'session';
}

function cookieOptions(config) {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/',
    maxAge: config.sessionMaxMs,
  };
}

function createSession(db, config, adminId) {
  const token = randomToken(32);
  const csrfToken = randomToken(32);
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id_hash, admin_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sha256Hex(token), adminId, csrfToken, now, now, now + config.sessionMaxMs);
  return { token, csrfToken };
}

function findSession(db, config, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const idHash = sha256Hex(token);
  const row = db.prepare(
    `SELECT s.id_hash, s.admin_id, s.csrf_token, s.last_seen_at, s.expires_at, a.username
       FROM sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.id_hash = ?`
  ).get(idHash);
  if (!row) return null;
  const now = Date.now();
  if (now >= row.expires_at || now - row.last_seen_at >= config.sessionIdleMs) {
    db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
    return null;
  }
  if (now - row.last_seen_at >= TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, idHash);
  }
  return row;
}

function destroySession(db, token) {
  if (typeof token === 'string') db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256Hex(token));
}

function destroyAdminSessions(db, adminId) {
  db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(adminId);
}

module.exports = { cookieName, cookieOptions, createSession, findSession, destroySession, destroyAdminSessions };
