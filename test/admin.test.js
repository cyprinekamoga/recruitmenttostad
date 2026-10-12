'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { setup, validApplication, apply, files, ADMIN } = require('./helpers');

describe('admin authentication', () => {
  let ctx;
  beforeEach(async () => {
    ctx = setup();
    await ctx.createAdmin();
  });
  afterEach(() => ctx.cleanup());

  test('every admin endpoint requires a session', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const routes = [
      ['get', '/api/admin/me'],
      ['get', '/api/admin/jobs'],
      ['post', '/api/admin/jobs'],
      ['get', `/api/admin/jobs/${id}`],
      ['put', `/api/admin/jobs/${id}`],
      ['delete', `/api/admin/jobs/${id}`],
      ['get', '/api/admin/applications'],
      ['get', `/api/admin/applications/${id}`],
      ['patch', `/api/admin/applications/${id}`],
      ['delete', `/api/admin/applications/${id}`],
      ['get', `/api/admin/files/${id}`],
      ['post', `/api/admin/applications/${id}/reference-requests`],
      ['post', `/api/admin/reference-requests/${id}/revoke`],
      ['get', '/api/admin/audit'],
      ['post', '/api/admin/password'],
      ['post', '/api/admin/logout'],
    ];
    for (const [method, url] of routes) {
      const res = await request(ctx.app)[method](url).set('Cookie', 'session=forged-session-token-value-123456');
      assert.equal(res.status, 401, `${method.toUpperCase()} ${url}`);
    }
  });

  test('wrong password, unknown user and missing code all get the same answer', async () => {
    const wrong = await request(ctx.app).post('/api/admin/login').send({ username: ADMIN.username, password: 'wrong password!!', code: ctx.nextCode() }).expect(401);
    const unknown = await request(ctx.app).post('/api/admin/login').send({ username: 'nobody', password: ADMIN.password, code: '123456' }).expect(401);
    const noCode = await request(ctx.app).post('/api/admin/login').send({ username: ADMIN.username, password: ADMIN.password }).expect(401);
    assert.equal(wrong.body.error, unknown.body.error);
    assert.equal(wrong.body.error, noCode.body.error);
  });

  test('successful login sets a hardened cookie and stores only a hash of it', async () => {
    const { res } = await ctx.login();
    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    const token = cookie.split(';')[0].split('=')[1];
    const sessions = JSON.stringify(ctx.db.prepare('SELECT * FROM sessions').all());
    assert.ok(!sessions.includes(token), 'raw session token must not be stored');
  });

  test('uses __Host- secure cookies when served over HTTPS', async () => {
    const https = setup({ env: { PUBLIC_BASE_URL: 'https://jobs.example.com' } });
    try {
      const { res } = await https.login();
      const cookie = res.headers['set-cookie'][0];
      assert.match(cookie, /^__Host-session=/);
      assert.match(cookie, /Secure/);
      assert.match(res.headers['strict-transport-security'], /max-age=/);
    } finally {
      https.cleanup();
    }
  });

  test('an authenticator code cannot be replayed', async () => {
    const code = ctx.nextCode();
    await request(ctx.app).post('/api/admin/login').send({ username: ADMIN.username, password: ADMIN.password, code }).expect(200);
    await request(ctx.app).post('/api/admin/login').send({ username: ADMIN.username, password: ADMIN.password, code }).expect(401);
  });

  test('account locks after repeated failures, even for the right password', async () => {
    for (let i = 0; i < ctx.config.loginMaxFailures; i++) {
      await request(ctx.app).post('/api/admin/login').send({ username: ADMIN.username, password: `wrong-password-${i}` });
    }
    await request(ctx.app).post('/api/admin/login').send({ username: ADMIN.username, password: ADMIN.password, code: ctx.nextCode() }).expect(401);
    const actions = ctx.db.prepare('SELECT action FROM audit_log').pluck().all();
    assert.ok(actions.includes('login.blocked_locked'));
  });

  test('login attempts are rate limited per network', async () => {
    let last;
    for (let i = 0; i <= ctx.config.rateLimits.loginPer15Min; i++) {
      last = await request(ctx.app).post('/api/admin/login').send({ username: 'x', password: 'y' });
    }
    assert.equal(last.status, 429);
  });

  test('state-changing requests need the CSRF token', async () => {
    const { agent, csrf } = await ctx.login();
    const job = { title: 'Accountant', description: 'Count things.' };
    await agent.post('/api/admin/jobs').send(job).expect(403);
    await agent.post('/api/admin/jobs').set('X-CSRF-Token', 'wrong').send(job).expect(403);
    await agent.post('/api/admin/jobs').set('X-CSRF-Token', csrf).send(job).expect(201);
  });

  test('logout ends the session on the server', async () => {
    const { agent, csrf } = await ctx.login();
    await agent.get('/api/admin/me').expect(200);
    await agent.post('/api/admin/logout').set('X-CSRF-Token', csrf).expect(200);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  });

  test('idle and expired sessions are rejected', async () => {
    const { agent } = await ctx.login();
    ctx.db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - ctx.config.sessionIdleMs - 1000);
    await agent.get('/api/admin/me').expect(401);

    const second = await ctx.login();
    ctx.db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1);
    await second.agent.get('/api/admin/me').expect(401);
  });

  test('changing the password signs out other sessions', async () => {
    const first = await ctx.login();
    const second = await ctx.login();
    const weak = await second.agent.post('/api/admin/password').set('X-CSRF-Token', second.csrf).send({ currentPassword: ADMIN.password, newPassword: 'short' });
    assert.equal(weak.status, 400);
    const res = await second.agent
      .post('/api/admin/password')
      .set('X-CSRF-Token', second.csrf)
      .send({ currentPassword: ADMIN.password, newPassword: 'a brand new long passphrase' })
      .expect(200);
    await first.agent.get('/api/admin/me').expect(401);
    const me = await second.agent.get('/api/admin/me').expect(200);
    assert.equal(me.body.csrfToken, res.body.csrfToken);
  });
});

describe('admin application management', () => {
  let ctx;
  let admin;
  let job;
  let applicationId;

  beforeEach(async () => {
    ctx = setup();
    admin = await ctx.login();
    job = await ctx.createJob(admin.agent, admin.csrf);
    await apply(ctx.app, job.slug, validApplication(job), { extra: (req) => req.attach('coverLetter', files.docx(), 'Cover "letter".docx') }).expect(201);
    applicationId = ctx.db.prepare('SELECT id FROM applications').pluck().get();
  });
  afterEach(() => ctx.cleanup());

  const auth = (req) => req.set('X-CSRF-Token', admin.csrf);

  test('lists and shows decrypted applications, and audits each view', async () => {
    const list = await admin.agent.get('/api/admin/applications').expect(200);
    assert.equal(list.body.applications.length, 1);
    assert.equal(list.body.applications[0].fullName, 'Jane Applicant');

    const detail = await admin.agent.get(`/api/admin/applications/${applicationId}`).expect(200);
    const app = detail.body.application;
    assert.equal(app.email, 'jane.applicant@example.org');
    assert.equal(app.answers[1].answer, 'I love sales.');
    assert.equal(app.references[0].name, 'Robert Referee');
    assert.equal(app.files.length, 2);

    const audit = ctx.db.prepare("SELECT target FROM audit_log WHERE action = 'application.view'").pluck().all();
    assert.deepEqual(audit, [applicationId]);
    const auditText = JSON.stringify(ctx.db.prepare('SELECT * FROM audit_log').all());
    assert.ok(!auditText.includes('Jane'), 'audit log must not contain applicant names');
  });

  test('flags repeat applicants without revealing anything to the public', async () => {
    await apply(ctx.app, job.slug, validApplication(job, { email: 'JANE.APPLICANT@example.org ' })).expect(201);
    const list = await admin.agent.get('/api/admin/applications').expect(200);
    assert.ok(list.body.applications.every((a) => a.otherApplications === 1));
  });

  test('downloads files as attachments with the original bytes', async () => {
    const detail = await admin.agent.get(`/api/admin/applications/${applicationId}`).expect(200);
    const cv = detail.body.application.files.find((f) => f.kind === 'cv');
    const res = await admin.agent.get(`/api/admin/files/${cv.id}`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    assert.deepEqual(res.body, files.pdf());
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.match(res.headers['content-disposition'], /^attachment;/);
    assert.match(res.headers['content-security-policy'], /sandbox/);
    assert.match(res.headers['cache-control'], /no-store/);

    const letter = detail.body.application.files.find((f) => f.kind === 'cover_letter');
    const letterRes = await admin.agent.get(`/api/admin/files/${letter.id}`).expect(200);
    assert.match(letterRes.headers['content-disposition'], /filename="Cover letter.docx"/);
  });

  test('a tampered file on disk is refused rather than served', async () => {
    const fileId = ctx.db.prepare("SELECT id FROM files WHERE kind = 'cv'").pluck().get();
    const filePath = path.join(ctx.config.uploadDir, `${fileId}.bin`);
    const bytes = fs.readFileSync(filePath);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(filePath, bytes);
    const res = await admin.agent.get(`/api/admin/files/${fileId}`).expect(500);
    assert.deepEqual(Object.keys(res.body), ['error']);
  });

  test('updates status and encrypted notes', async () => {
    await auth(admin.agent.patch(`/api/admin/applications/${applicationId}`)).send({ status: 'bogus' }).expect(400);
    await auth(admin.agent.patch(`/api/admin/applications/${applicationId}`))
      .send({ status: 'shortlisted', notes: 'Strong candidate, call Tuesday' })
      .expect(200);
    const row = ctx.db.prepare('SELECT status, notes_enc FROM applications').get();
    assert.equal(row.status, 'shortlisted');
    assert.ok(!row.notes_enc.includes('Strong'));
    const detail = await admin.agent.get(`/api/admin/applications/${applicationId}`).expect(200);
    assert.equal(detail.body.application.notes, 'Strong candidate, call Tuesday');
  });

  test('deleting an application removes its rows and files', async () => {
    const fileIds = ctx.db.prepare('SELECT id FROM files').pluck().all();
    await auth(admin.agent.delete(`/api/admin/applications/${applicationId}`)).expect(200);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM applications').get().n, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
    for (const id of fileIds) assert.ok(!fs.existsSync(path.join(ctx.config.uploadDir, `${id}.bin`)));
  });

  test('jobs with applications cannot be deleted', async () => {
    await auth(admin.agent.delete(`/api/admin/jobs/${job.id}`)).expect(409);
  });

  test('malformed ids are rejected cleanly', async () => {
    await admin.agent.get(`/api/admin/applications/${encodeURIComponent("' OR '1'='1")}`).expect(404);
    await admin.agent.get('/api/admin/files/..%2F..%2Frecruitment.db').expect(404);
    await admin.agent.get('/api/admin/applications?status=new%27%20OR%201=1').expect(200);
  });
});
