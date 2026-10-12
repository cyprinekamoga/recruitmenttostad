'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup } = require('./helpers');
const { codeForStep, currentStep } = require('../src/security/totp');

const SETUP_CODE = 'a-long-random-setup-code-from-the-host';
const account = { setupCode: SETUP_CODE, username: 'owner', password: 'lamp river orange pocket' };

describe('browser first-time setup', () => {
  let ctx;
  afterEach(() => ctx.cleanup());

  test('is off when no SETUP_CODE is configured', async () => {
    ctx = setup();
    const status = await request(ctx.app).get('/api/setup/status').expect(200);
    assert.equal(status.body.state, 'disabled');
    await request(ctx.app).post('/api/setup/start').send(account).expect(404);
  });

  test('rejects a wrong setup code and weak passwords, storing nothing', async () => {
    ctx = setup({ env: { SETUP_CODE } });
    const wrong = await request(ctx.app).post('/api/setup/start').send({ ...account, setupCode: 'wrong-code-wrong-code-wrong' }).expect(403);
    assert.ok(wrong.body.fields.setupCode);
    const weak = await request(ctx.app).post('/api/setup/start').send({ ...account, password: 'short' }).expect(400);
    assert.ok(weak.body.fields.password);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM admins').get().n, 0);
  });

  test('creates the first admin with 2FA, signs them in, then switches itself off', async () => {
    ctx = setup({ env: { SETUP_CODE } });
    assert.equal((await request(ctx.app).get('/api/setup/status')).body.state, 'ready');

    const start = await request(ctx.app).post('/api/setup/start').send(account).expect(200);
    assert.match(start.body.totpSecret, /^[A-Z2-7]{32}$/);
    assert.match(start.body.qrCode, /^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(start.body.qrCode.split(',')[1], 'base64').toString();
    assert.ok(svg.startsWith('<svg') && !/<script|\son\w+=/i.test(svg));
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM admins').get().n, 0, 'nothing stored before confirmation');

    const secret = start.body.totpSecret;
    await request(ctx.app).post('/api/setup/complete').send({ ...account, totpSecret: secret, code: '000000' }).expect(400);

    const agent = request.agent(ctx.app);
    const code = codeForStep(secret, currentStep());
    await agent.post('/api/setup/complete').send({ ...account, totpSecret: secret, code }).expect(201);
    const me = await agent.get('/api/admin/me').expect(200);
    assert.equal(me.body.username, 'owner');

    // Off for good: no second account, no takeover.
    assert.equal((await request(ctx.app).get('/api/setup/status')).body.state, 'done');
    await request(ctx.app).post('/api/setup/start').send({ ...account, username: 'intruder' }).expect(404);
    const next = codeForStep(secret, currentStep() + 1);
    await request(ctx.app).post('/api/setup/complete').send({ ...account, username: 'intruder', totpSecret: secret, code: next }).expect(404);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM admins').get().n, 1);

    // The new account needs its authenticator code to sign in, and the setup code can't be replayed.
    await request(ctx.app).post('/api/admin/login').send({ username: 'owner', password: account.password }).expect(401);
    await request(ctx.app).post('/api/admin/login').send({ username: 'owner', password: account.password, code }).expect(401);
    await request(ctx.app).post('/api/admin/login').send({ username: 'owner', password: account.password, code: next }).expect(200);
  });

  test('two simultaneous setups cannot both succeed', async () => {
    ctx = setup({ env: { SETUP_CODE } });
    const start = await request(ctx.app).post('/api/setup/start').send(account).expect(200);
    const secret = start.body.totpSecret;
    const code = codeForStep(secret, currentStep());
    const results = await Promise.all([
      request(ctx.app).post('/api/setup/complete').send({ ...account, username: 'first', totpSecret: secret, code }),
      request(ctx.app).post('/api/setup/complete').send({ ...account, username: 'second', totpSecret: secret, code }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 404]);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM admins').get().n, 1);
  });

  test('the setup page is not cached or indexed', async () => {
    ctx = setup({ env: { SETUP_CODE } });
    const page = await request(ctx.app).get('/setup').expect(200);
    assert.match(page.headers['cache-control'], /no-store/);
    assert.match(page.headers['x-robots-tag'], /noindex/);
  });
});

describe('hosting platform settings', () => {
  const crypto = require('node:crypto');
  const { loadConfig } = require('../src/config');
  const key = crypto.randomBytes(32).toString('base64');

  test('falls back to the platform URL until a custom domain is set', () => {
    const env = { NODE_ENV: 'production', DATA_ENCRYPTION_KEY: key, RENDER_EXTERNAL_URL: 'https://recruitment-abcd.onrender.com' };
    assert.equal(loadConfig(env).publicBaseUrl, 'https://recruitment-abcd.onrender.com');
    assert.equal(loadConfig({ ...env, PUBLIC_BASE_URL: 'https://careers.example.com' }).publicBaseUrl, 'https://careers.example.com');
  });

  test('a short SETUP_CODE is refused at start-up', () => {
    assert.throws(() => loadConfig({ DATA_ENCRYPTION_KEY: key, SETUP_CODE: 'too-short' }), /SETUP_CODE/);
  });

  test('accepts generated keys of 256 bits or more, rejects passphrases', () => {
    assert.ok(loadConfig({ DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64url') }));
    assert.ok(loadConfig({ DATA_ENCRYPTION_KEY: crypto.randomBytes(48).toString('base64') }));
    assert.throws(() => loadConfig({ DATA_ENCRYPTION_KEY: 'my company password is very long and secret' }), /DATA_ENCRYPTION_KEY/);
    assert.throws(() => loadConfig({ DATA_ENCRYPTION_KEY: crypto.randomBytes(24).toString('base64') }), /DATA_ENCRYPTION_KEY/);
  });
});
