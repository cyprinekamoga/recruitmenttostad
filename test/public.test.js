'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { setup, validApplication, apply, files } = require('./helpers');

describe('public site and applications', () => {
  let ctx;
  let job;
  let closedJob;

  before(async () => {
    ctx = setup();
    const { agent, csrf } = await ctx.login();
    job = await ctx.createJob(agent, csrf);
    closedJob = await ctx.createJob(agent, csrf, { title: 'Closed role', isOpen: false });
  });
  after(() => ctx.cleanup());

  test('lists only open jobs, without internal fields', async () => {
    const res = await request(ctx.app).get('/api/jobs').expect(200);
    assert.equal(res.body.jobs.length, 1);
    assert.equal(res.body.jobs[0].slug, job.slug);
    assert.equal(res.body.jobs[0].id, undefined);
    await request(ctx.app).get(`/api/jobs/${closedJob.slug}`).expect(404);
  });

  test('a valid application is stored encrypted, CV included', async () => {
    const before = ctx.sent.length;
    const res = await apply(ctx.app, job.slug, validApplication(job)).expect(201);
    assert.match(res.body.reference, /^[0-9A-F]{8}$/);
    assert.deepEqual(Object.keys(res.body), ['reference'], 'response must not echo personal data');

    const row = ctx.db.prepare('SELECT * FROM applications').get();
    const rawRow = JSON.stringify(row);
    for (const secret of ['Jane', 'jane.applicant', '700 000000', 'Robert', 'I love sales', 'Entebbe']) {
      assert.ok(!rawRow.includes(secret), `"${secret}" must not appear in the database in plain text`);
    }
    const fileRow = ctx.db.prepare('SELECT * FROM files').get();
    assert.ok(!JSON.stringify(fileRow).includes('Jane CV'), 'file name is encrypted');

    const onDisk = fs.readFileSync(path.join(ctx.config.uploadDir, `${fileRow.id}.bin`));
    assert.ok(!onDisk.includes('%PDF'), 'CV must be encrypted on disk');
    assert.ok(!onDisk.includes('Jane Applicant CV text'));
    assert.deepEqual(ctx.fileStore.read(fileRow.id), files.pdf());

    const notification = ctx.sent.at(-1);
    assert.equal(ctx.sent.length, before + 1);
    assert.ok(!notification.text.includes('Jane') && !notification.text.includes('jane.applicant'), 'notification email has no applicant details');
  });

  test('rejects applications that miss required data, without echoing values', async () => {
    const payload = validApplication(job, { consent: false, email: 'not-an-email<script>' });
    payload.answers[job.questions[1].id] = '';
    const res = await apply(ctx.app, job.slug, payload).expect(400);
    assert.ok(res.body.fields.consent);
    assert.ok(res.body.fields.email);
    assert.ok(res.body.fields[`answers.${job.questions[1].id}`]);
    assert.ok(!JSON.stringify(res.body).includes('<script>'));
  });

  test('enforces question types, unknown fields and minimum references', async () => {
    const badChoice = validApplication(job);
    badChoice.answers[job.questions[2].id] = 'West';
    await apply(ctx.app, job.slug, badChoice).expect(400);

    await apply(ctx.app, job.slug, { ...validApplication(job), isAdmin: true }).expect(400);
    const extraAnswer = validApplication(job);
    extraAnswer.answers.injected = 'x';
    await apply(ctx.app, job.slug, extraAnswer).expect(400);

    const res = await apply(ctx.app, job.slug, validApplication(job, { references: [] })).expect(400);
    assert.ok(res.body.fields.references);

    await apply(ctx.app, job.slug, validApplication(job, { profileUrl: 'javascript:alert(1)' })).expect(400);
  });

  test('only accepts real PDF / DOCX files', async () => {
    const payload = validApplication(job);
    let res = await apply(ctx.app, job.slug, payload, { cv: null }).expect(400);
    assert.ok(res.body.fields.cv);

    res = await apply(ctx.app, job.slug, payload, { cv: files.exe(), cvName: 'cv.pdf' }).expect(400);
    assert.match(res.body.error, /Only PDF and Word/);

    res = await apply(ctx.app, job.slug, payload, { cv: files.pdfWithScript(), cvName: 'cv.pdf' }).expect(400);
    assert.match(res.body.error, /scripts/);

    res = await apply(ctx.app, job.slug, payload, { cv: files.docm(), cvName: 'cv.docx' }).expect(400);
    assert.match(res.body.error, /macros/);

    res = await apply(ctx.app, job.slug, payload, { cv: files.pdf(), cvName: 'cv.html' }).expect(400);
    assert.match(res.body.error, /extension/);

    await apply(ctx.app, job.slug, payload, { cv: files.docx(), cvName: 'cv.docx' }).expect(201);
  });

  test('rejects oversized files and unexpected file fields', async () => {
    const big = Buffer.concat([files.pdf(), Buffer.alloc(ctx.config.maxUploadBytes + 1)]);
    await apply(ctx.app, job.slug, validApplication(job), { cv: big, cvName: 'cv.pdf' }).expect(413);
    await apply(ctx.app, job.slug, validApplication(job), {
      extra: (req) => req.attach('payload', files.pdf(), 'evil.pdf'),
    }).expect(400);
  });

  test('cover letter is optional and validated the same way', async () => {
    await apply(ctx.app, job.slug, validApplication(job), {
      extra: (req) => req.attach('coverLetter', files.exe(), 'letter.pdf'),
    }).expect(400);
    await apply(ctx.app, job.slug, validApplication(job), {
      extra: (req) => req.attach('coverLetter', files.docx(), 'letter.docx'),
    }).expect(201);
  });

  test('honeypot submissions look successful but store nothing', async () => {
    const count = ctx.db.prepare('SELECT COUNT(*) AS n FROM applications').get().n;
    await apply(ctx.app, job.slug, validApplication(job, { website: 'http://spam.example' })).expect(201);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM applications').get().n, count);
  });

  test('closed or unknown jobs do not accept applications', async () => {
    await apply(ctx.app, closedJob.slug, validApplication(job)).expect(404);
    await apply(ctx.app, '../../etc/passwd', validApplication(job)).expect(404);
  });

  test('sets protective security headers', async () => {
    const page = await request(ctx.app).get('/').expect(200);
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.equal(page.headers['x-powered-by'], undefined);

    const api = await request(ctx.app).get('/api/jobs').expect(200);
    assert.match(api.headers['cache-control'], /no-store/);

    const admin = await request(ctx.app).get('/admin/').expect(200);
    assert.match(admin.headers['x-robots-tag'], /noindex/);
  });

  test('does not serve the database, uploads or source files', async () => {
    for (const url of ['/data/recruitment.db', '/../data/recruitment.db', '/.env', '/src/app.js', '/package.json', '/uploads/']) {
      const res = await request(ctx.app).get(url);
      assert.equal(res.status, 404, url);
    }
  });

  test('applying is rate limited per network', async () => {
    const limited = setup({ env: { RATE_LIMIT_APPLICATIONS_PER_HOUR: '2' } });
    try {
      const { agent, csrf } = await limited.login();
      const limitedJob = await limited.createJob(agent, csrf);
      await apply(limited.app, limitedJob.slug, validApplication(limitedJob)).expect(201);
      await apply(limited.app, limitedJob.slug, validApplication(limitedJob)).expect(201);
      await apply(limited.app, limitedJob.slug, validApplication(limitedJob)).expect(429);
    } finally {
      limited.cleanup();
    }
  });
});
