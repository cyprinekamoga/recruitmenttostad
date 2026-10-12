'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// Each entry runs once, in order. Never edit a shipped migration; append a new one.
const MIGRATIONS = [
  `
  CREATE TABLE admins (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    totp_secret_enc TEXT,
    last_totp_step INTEGER,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL
  );

  -- Only a SHA-256 hash of the session token is stored, so a copy of the
  -- database cannot be used to hijack a live admin session.
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_admin ON sessions(admin_id);

  -- Job postings are public information and are stored in plain text.
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    employment_type TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    questions TEXT NOT NULL DEFAULT '[]',
    references_required INTEGER NOT NULL DEFAULT 0,
    is_open INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- All personal data lives inside data_enc / notes_enc (AES-256-GCM).
  -- email_hash is a keyed HMAC used only to spot repeat applicants.
  CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    status TEXT NOT NULL DEFAULT 'new',
    email_hash TEXT NOT NULL,
    data_enc TEXT NOT NULL,
    notes_enc TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX applications_job ON applications(job_id);
  CREATE INDEX applications_email ON applications(email_hash);
  CREATE INDEX applications_updated ON applications(updated_at);

  -- File contents are encrypted on disk under uploads/<id>.bin.
  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    original_name_enc TEXT NOT NULL,
    file_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX files_application ON files(application_id);

  CREATE TABLE reference_requests (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    referee_index INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    response_enc TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX reference_requests_application ON reference_requests(application_id);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX audit_log_created ON audit_log(created_at);
  `,
];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Overwrite deleted rows with zeros instead of leaving them in free pages.
  db.pragma('secure_delete = ON');
  db.pragma('busy_timeout = 5000');
  if (file !== ':memory:' && process.platform !== 'win32') fs.chmodSync(file, 0o600);
  migrate(db);
  return db;
}

module.exports = { openDatabase };
