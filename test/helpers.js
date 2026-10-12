'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createCryptoBox } = require('../src/crypto');
const { createFileStore } = require('../src/files');
const { createApp } = require('../src/app');
const { upsertAdmin } = require('../src/admins');
const { codeForStep, currentStep } = require('../src/security/totp');

const silentLogger = { info() {}, error() {}, warn() {} };

const ADMIN = { username: 'hiring.manager', password: 'correct horse battery staple' };

const files = {
  pdf: () => Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\nJane Applicant CV text\ntrailer << /Root 1 0 R >>\n%%EOF\n'),
  docx: () => Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.from('....[Content_Types].xml....word/document.xml....')]),
  docm: () => Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.from('....word/document.xml....word/vbaProject.bin....')]),
  pdfWithScript: () => Buffer.from('%PDF-1.7\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF\n'),
  exe: () => Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(200)]),
};

function setup({ env = {}, mailEnabled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitment-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dir,
    DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: 'http://localhost:3000',
    COMPANY_NAME: 'Test Co',
    NOTIFY_EMAIL: 'hiring@example.com',
    RATE_LIMIT_APPLICATIONS_PER_HOUR: '1000',
    MAX_UPLOAD_MB: '1',
    ...env,
  });
  const db = openDatabase(config.dbFile);
  const cryptoBox = createCryptoBox(config.encryptionKey);
  const fileStore = createFileStore({ uploadDir: config.uploadDir, cryptoBox });
  const sent = [];
  const mailer = mailEnabled
    ? { enabled: true, async send(message) { sent.push(message); return true; } }
    : { enabled: false, async send() { return false; } };
  const app = createApp({ config, db, cryptoBox, fileStore, mailer, logger: silentLogger });

  let totpSecret = null;
  let nextStepOffset = -1;

  return {
    app,
    db,
    config,
    cryptoBox,
    fileStore,
    sent,
    dir,
    async createAdmin(options = {}) {
      const result = await upsertAdmin(db, cryptoBox, { ...ADMIN, enableTotp: true, ...options });
      totpSecret = result.totpSecret;
      nextStepOffset = -1;
      return result;
    },
    /** A fresh, unused authenticator code (each code can only be used once). */
    nextCode() {
      if (nextStepOffset > 1) throw new Error('Out of valid TOTP steps in this window');
      return codeForStep(totpSecret, currentStep() + nextStepOffset++);
    },
    async login() {
      if (!totpSecret) await this.createAdmin();
      const agent = request.agent(app);
      const res = await agent
        .post('/api/admin/login')
        .send({ username: ADMIN.username, password: ADMIN.password, code: this.nextCode() })
        .expect(200);
      return { agent, csrf: res.body.csrfToken, res };
    },
    async createJob(agent, csrf, overrides = {}) {
      const res = await agent
        .post('/api/admin/jobs')
        .set('X-CSRF-Token', csrf)
        .send({
          title: 'Field Sales Representative',
          location: 'Kampala',
          employmentType: 'Full-time',
          description: 'Sell our products.\nTravel required.',
          referencesRequired: 1,
          questions: [
            { label: 'Do you have a driving licence?', type: 'yes_no', required: true },
            { label: 'Why do you want this role?', type: 'long_text', required: true },
            { label: 'Preferred region', type: 'single_choice', required: false, options: ['North', 'South'] },
          ],
          ...overrides,
        })
        .expect(201);
      return res.body.job;
    },
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function validApplication(job, overrides = {}) {
  const [licence, motivation, region] = job.questions;
  return {
    fullName: 'Jane Applicant',
    email: 'jane.applicant@example.org',
    phone: '+256 700 000000',
    location: 'Entebbe',
    profileUrl: 'https://www.linkedin.com/in/jane-applicant',
    answers: { [licence.id]: 'yes', [motivation.id]: 'I love sales.', [region.id]: 'North' },
    references: [
      { name: 'Robert Referee', relationship: 'Former manager', organisation: 'Acme Ltd', email: 'robert.referee@example.org', phone: '+256 711 111111' },
    ],
    consent: true,
    ...overrides,
  };
}

function apply(app, slug, payload, { cv = files.pdf(), cvName = 'Jane CV.pdf', extra } = {}) {
  let req = request(app).post(`/api/jobs/${slug}/apply`).field('application', JSON.stringify(payload));
  if (cv) req = req.attach('cv', cv, cvName);
  if (extra) req = extra(req);
  return req;
}

module.exports = { setup, validApplication, apply, files, ADMIN };
