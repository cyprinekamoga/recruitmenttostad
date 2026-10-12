'use strict';

const express = require('express');
const { z } = require('zod');
const { renderSVG } = require('uqr');
const { safeEqual } = require('../crypto');
const { audit } = require('../audit');
const { upsertAdmin, AdminExistsError, USERNAME_PATTERN } = require('../admins');
const { HttpError, parseOrThrow } = require('../errors');
const { passwordProblem } = require('../security/passwords');
const { generateSecret, verifyTotp, otpauthUri } = require('../security/totp');
const { cookieName, cookieOptions, createSession } = require('../security/sessions');

const NOT_AVAILABLE = 'Setup is not available.';

const accountSchema = {
  setupCode: z.string().max(200),
  username: z.string().trim().regex(USERNAME_PATTERN, 'Use 3-64 letters, numbers, dots, dashes, underscores or @.'),
  password: z.string().max(256),
};
const startSchema = z.strictObject(accountSchema);
const completeSchema = z.strictObject({
  ...accountSchema,
  totpSecret: z.string().regex(/^[A-Z2-7]{32}$/),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code shown in your app.'),
});

/**
 * First-run setup in the browser, for hosts without a terminal. It is only
 * available while SETUP_CODE is set and no admin exists yet. Once the first
 * admin is created, every endpoint answers 404, so it can never be used to add
 * accounts or take over the portal.
 */
function setupRoutes({ db, config, cryptoBox, limiters }) {
  const router = express.Router();

  const adminExists = () => Boolean(db.prepare('SELECT 1 FROM admins LIMIT 1').get());

  function checkAccess(data) {
    if (!config.setupCode || adminExists()) throw new HttpError(404, NOT_AVAILABLE);
    if (!safeEqual(data.setupCode.trim(), config.setupCode)) {
      throw new HttpError(403, 'That setup code is not correct.', { setupCode: 'That setup code is not correct.' });
    }
    const problem = passwordProblem(data.password);
    if (problem) throw new HttpError(400, problem, { password: problem });
  }

  router.get('/status', (req, res) => {
    const state = adminExists() ? 'done' : config.setupCode ? 'ready' : 'disabled';
    res.json({ state, companyName: config.companyName });
  });

  // Step 1: check the setup code and chosen password, then hand out a fresh
  // authenticator secret. Nothing is stored yet.
  router.post('/start', limiters.login, (req, res) => {
    const data = parseOrThrow(startSchema, req.body ?? {});
    checkAccess(data);
    const totpSecret = generateSecret();
    const uri = otpauthUri({ secret: totpSecret, account: data.username, issuer: config.companyName });
    const qrCode = `data:image/svg+xml;base64,${Buffer.from(renderSVG(uri, { border: 2 })).toString('base64')}`;
    res.json({ totpSecret, qrCode });
  });

  // Step 2: the account is created only once a code from the authenticator app
  // proves it was set up correctly, so the owner can't lock themselves out.
  router.post('/complete', limiters.login, async (req, res) => {
    const data = parseOrThrow(completeSchema, req.body ?? {});
    checkAccess(data);
    const step = verifyTotp(data.totpSecret, data.code);
    if (step === null) {
      const message = "That code didn't match. Use the newest code, and check your phone sets its clock automatically.";
      throw new HttpError(400, message, { code: message });
    }

    let admin;
    try {
      admin = await upsertAdmin(db, cryptoBox, {
        username: data.username,
        password: data.password,
        totpSecret: data.totpSecret,
        onlyIfNoAdmins: true,
      });
    } catch (error) {
      if (error instanceof AdminExistsError) throw new HttpError(404, NOT_AVAILABLE);
      throw error;
    }
    db.prepare('UPDATE admins SET last_totp_step = ? WHERE id = ?').run(step, admin.id);

    const session = createSession(db, config, admin.id);
    res.cookie(cookieName(config), session.token, cookieOptions(config));
    audit(db, { adminId: admin.id, action: 'setup.first_admin', ip: req.ip });
    res.status(201).json({ ok: true });
  });

  return router;
}

module.exports = { setupRoutes };
