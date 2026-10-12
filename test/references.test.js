'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, validApplication, apply } = require('./helpers');

describe('reference requests', () => {
  let ctx;
  let admin;
  let applicationId;

  const response = (token, overrides = {}) => ({
    token,
    relationship: 'I managed Jane for three years at Acme.',
    knownFor: '3 years',
    strengths: 'Reliable, great with customers.',
    development: 'Could delegate more.',
    wouldReemploy: 'yes',
    comments: '',
    confirm: true,
    ...overrides,
  });

  function requestReference(body = { refereeIndex: 0 }) {
    return admin.agent
      .post(`/api/admin/applications/${applicationId}/reference-requests`)
      .set('X-CSRF-Token', admin.csrf)
      .send(body);
  }

  const tokenFrom = (link) => new URL(link).hash.slice(1);

  beforeEach(async () => {
    ctx = setup();
    admin = await ctx.login();
    const job = await ctx.createJob(admin.agent, admin.csrf);
    await apply(ctx.app, job.slug, validApplication(job)).expect(201);
    applicationId = ctx.db.prepare('SELECT id FROM applications').pluck().get();
  });
  afterEach(() => ctx.cleanup());

  test('issues a one-time link with the token in the URL fragment and stores only its hash', async () => {
    const res = await requestReference().expect(201);
    const url = new URL(res.body.link);
    assert.equal(url.origin + url.pathname, 'http://localhost:3000/reference');
    assert.equal(url.search, '', 'token must not be in the query string (it would reach server logs)');
    const token = tokenFrom(res.body.link);
    assert.ok(token.length >= 40);
    const stored = JSON.stringify(ctx.db.prepare('SELECT * FROM reference_requests').all());
    assert.ok(!stored.includes(token));
  });

  test('the referee sees only what they need', async () => {
    const token = tokenFrom((await requestReference().expect(201)).body.link);
    const res = await request(ctx.app).post('/api/references/lookup').send({ token }).expect(200);
    assert.equal(res.body.candidateName, 'Jane Applicant');
    assert.equal(res.body.refereeName, 'Robert Referee');
    assert.equal(res.body.jobTitle, 'Field Sales Representative');
    const body = JSON.stringify(res.body);
    for (const hidden of ['jane.applicant@example.org', '700 000000', 'I love sales', 'Entebbe']) {
      assert.ok(!body.includes(hidden), `referee must not see ${hidden}`);
    }
  });

  test('a reference can be submitted once, and is stored encrypted', async () => {
    const token = tokenFrom((await requestReference().expect(201)).body.link);
    await request(ctx.app).post('/api/references/submit').send(response(token)).expect(201);
    await request(ctx.app).post('/api/references/submit').send(response(token)).expect(404);
    await request(ctx.app).post('/api/references/lookup').send({ token }).expect(404);

    const row = ctx.db.prepare('SELECT * FROM reference_requests').get();
    assert.equal(row.status, 'completed');
    assert.ok(!row.response_enc.includes('Reliable'));

    const detail = await admin.agent.get(`/api/admin/applications/${applicationId}`).expect(200);
    assert.equal(detail.body.application.referenceRequests[0].response.strengths, 'Reliable, great with customers.');
  });

  test('validates the referee form', async () => {
    const token = tokenFrom((await requestReference().expect(201)).body.link);
    const res = await request(ctx.app).post('/api/references/submit').send(response(token, { confirm: false, wouldReemploy: 'maybe' })).expect(400);
    assert.ok(res.body.fields.confirm);
    assert.ok(res.body.fields.wouldReemploy);
  });

  test('expired, revoked, replaced and made-up links do not work', async () => {
    const first = tokenFrom((await requestReference().expect(201)).body.link);
    const second = (await requestReference().expect(201)).body;
    await request(ctx.app).post('/api/references/lookup').send({ token: first }).expect(404);
    await request(ctx.app).post('/api/references/lookup').send({ token: tokenFrom(second.link) }).expect(200);

    await admin.agent.post(`/api/admin/reference-requests/${second.id}/revoke`).set('X-CSRF-Token', admin.csrf).expect(200);
    await request(ctx.app).post('/api/references/lookup').send({ token: tokenFrom(second.link) }).expect(404);

    const third = tokenFrom((await requestReference().expect(201)).body.link);
    ctx.db.prepare("UPDATE reference_requests SET expires_at = ? WHERE status = 'pending'").run(Date.now() - 1);
    await request(ctx.app).post('/api/references/lookup').send({ token: third }).expect(404);

    await request(ctx.app).post('/api/references/lookup').send({ token: 'A'.repeat(43) }).expect(404);
    await request(ctx.app).post('/api/references/lookup').send({ token: "' OR 1=1 --" }).expect(400);
  });

  test('emails the referee when asked to', async () => {
    const res = await requestReference({ refereeIndex: 0, sendEmail: true }).expect(201);
    assert.equal(res.body.emailed, true);
    const mail = ctx.sent.at(-1);
    assert.equal(mail.to, 'robert.referee@example.org');
    assert.ok(mail.text.includes(res.body.link));
  });

  test('refuses referees that do not exist', async () => {
    await requestReference({ refereeIndex: 3 }).expect(400);
  });
});
