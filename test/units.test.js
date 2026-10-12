'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCryptoBox } = require('../src/crypto');
const { codeForStep, verifyTotp } = require('../src/security/totp');
const { loadConfig, ConfigError } = require('../src/config');
const { cleanFileName } = require('../src/files');
const { runMaintenance } = require('../src/maintenance');
const { setup, validApplication, apply } = require('./helpers');

describe('encryption', () => {
  const box = createCryptoBox(crypto.randomBytes(32).toString('base64'));

  test('round-trips and binds ciphertext to its record', () => {
    const stored = box.encryptJSON({ name: 'Jane' }, 'application:1');
    assert.deepEqual(box.decryptJSON(stored, 'application:1'), { name: 'Jane' });
    assert.throws(() => box.decryptJSON(stored, 'application:2'));
  });

  test('detects tampering', () => {
    const payload = box.encrypt(Buffer.from('secret'), 'x');
    payload[payload.length - 1] ^= 1;
    assert.throws(() => box.decrypt(payload, 'x'));
  });

  test('uses a fresh IV every time', () => {
    assert.notEqual(box.encryptString('same', 'x'), box.encryptString('same', 'x'));
  });

  test('a different key cannot decrypt', () => {
    const other = createCryptoBox(crypto.randomBytes(32).toString('base64'));
    assert.throws(() => other.decryptString(box.encryptString('secret', 'x'), 'x'));
  });
});

describe('TOTP', () => {
  // RFC 6238 test vector: ASCII "12345678901234567890" in base32.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  test('matches the RFC 6238 test vectors', () => {
    assert.equal(codeForStep(secret, Math.floor(59 / 30)), '287082');
    assert.equal(codeForStep(secret, Math.floor(1111111109 / 30)), '081804');
  });

  test('accepts adjacent steps and rejects replays and garbage', () => {
    const now = 1111111109 * 1000;
    const step = Math.floor(1111111109 / 30);
    assert.equal(verifyTotp(secret, '081804', { now }), step);
    assert.equal(verifyTotp(secret, '081804', { now, lastUsedStep: step }), null);
    assert.equal(verifyTotp(secret, codeForStep(secret, step + 5), { now }), null);
    assert.equal(verifyTotp(secret, 'abcdef', { now }), null);
  });
});

describe('configuration', () => {
  const key = crypto.randomBytes(32).toString('base64');

  test('refuses to start without a valid encryption key', () => {
    assert.throws(() => loadConfig({}), ConfigError);
    assert.throws(() => loadConfig({ DATA_ENCRYPTION_KEY: 'too-short' }), ConfigError);
  });

  test('refuses plain HTTP in production', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', DATA_ENCRYPTION_KEY: key, PUBLIC_BASE_URL: 'http://jobs.example.com' }), /https/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', DATA_ENCRYPTION_KEY: key }), /PUBLIC_BASE_URL/);
    const config = loadConfig({ NODE_ENV: 'production', DATA_ENCRYPTION_KEY: key, PUBLIC_BASE_URL: 'https://jobs.example.com/' });
    assert.equal(config.publicBaseUrl, 'https://jobs.example.com');
    assert.equal(config.secureCookies, true);
  });

  test('refuses TRUST_PROXY=true, which would let clients spoof their IP', () => {
    assert.throws(() => loadConfig({ DATA_ENCRYPTION_KEY: key, TRUST_PROXY: 'true' }), ConfigError);
    assert.equal(loadConfig({ DATA_ENCRYPTION_KEY: key, TRUST_PROXY: '1' }).trustProxy, 1);
  });
});

describe('file names', () => {
  test('strips paths and dangerous characters', () => {
    assert.equal(cleanFileName('../../etc/passwd', 'pdf'), 'passwd.pdf');
    assert.equal(cleanFileName('C:\\Users\\me\\My "CV".PDF', 'pdf'), 'My CV.pdf');
    assert.equal(cleanFileName('a\r\nb<script>.docx', 'docx'), 'abscript.docx');
    assert.equal(cleanFileName('', 'docx'), 'document.docx');
  });
});

describe('retention and clean-up', () => {
  test('deletes applications past the retention period, with their files', async () => {
    const ctx = setup({ env: { RETENTION_DAYS: '30' } });
    try {
      const admin = await ctx.login();
      const job = await ctx.createJob(admin.agent, admin.csrf);
      await apply(ctx.app, job.slug, validApplication(job)).expect(201);
      await apply(ctx.app, job.slug, validApplication(job)).expect(201);
      const [oldId, newId] = ctx.db.prepare('SELECT id FROM applications ORDER BY created_at').pluck().all();
      const oldFile = ctx.db.prepare('SELECT id FROM files WHERE application_id = ?').pluck().get(oldId);
      ctx.db.prepare('UPDATE applications SET updated_at = ? WHERE id = ?').run(Date.now() - 31 * 24 * 3600 * 1000, oldId);

      const result = runMaintenance({ db: ctx.db, config: ctx.config, fileStore: ctx.fileStore, logger: { info() {} } });
      assert.equal(result.purged, 1);
      assert.deepEqual(ctx.db.prepare('SELECT id FROM applications').pluck().all(), [newId]);
      assert.ok(!fs.existsSync(path.join(ctx.config.uploadDir, `${oldFile}.bin`)));
    } finally {
      ctx.cleanup();
    }
  });

  test('removes orphaned uploads and expired sessions', async () => {
    const ctx = setup();
    try {
      await ctx.login();
      const orphan = path.join(ctx.config.uploadDir, `${crypto.randomUUID()}.bin`);
      fs.writeFileSync(orphan, 'leftover');
      const old = new Date(Date.now() - 2 * 3600 * 1000);
      fs.utimesSync(orphan, old, old);
      ctx.db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1);

      runMaintenance({ db: ctx.db, config: ctx.config, fileStore: ctx.fileStore, logger: { info() {} } });
      assert.ok(!fs.existsSync(orphan));
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    } finally {
      ctx.cleanup();
    }
  });
});
