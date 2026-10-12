'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { randomToken, sha256Hex } = require('../crypto');
const { audit } = require('../audit');
const { totpAad } = require('../admins');
const { HttpError, parseOrThrow } = require('../errors');
const { FILE_TYPES } = require('../files');
const { hashPassword, verifyPassword, passwordProblem } = require('../security/passwords');
const { verifyTotp } = require('../security/totp');
const { requireAdmin, requireCsrf } = require('../security/middleware');
const {
  cookieName,
  cookieOptions,
  createSession,
  destroySession,
  destroyAdminSessions,
} = require('../security/sessions');
const {
  jobSchema,
  loginSchema,
  applicationUpdateSchema,
  referenceRequestSchema,
  passwordChangeSchema,
  APPLICATION_STATUSES,
} = require('../schemas');
const {
  rowToJob,
  makeSlug,
  applicationAad,
  notesAad,
  fileNameAad,
  referenceAad,
  shortRef,
  deleteApplication,
} = require('../records');
const { singleLine } = require('../mailer');

const LOGIN_FAILED = 'Sign-in failed. Check your username, password and authenticator code. After repeated failures the account is locked for 15 minutes.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function adminRoutes({ db, config, cryptoBox, fileStore, mailer, limiters, logger }) {
  const router = express.Router();
  router.use(limiters.adminApi);

  const record = (req, action, target = null) =>
    audit(db, { adminId: req.admin?.id ?? null, action, target, ip: req.ip });

  // ---- Authentication ------------------------------------------------------

  router.post('/login', limiters.login, async (req, res) => {
    const { username, password, code } = parseOrThrow(loginSchema, req.body ?? {});
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    const now = Date.now();
    // Always run the (slow) password check so timing doesn't reveal valid usernames or locks.
    const passwordOk = await verifyPassword(admin?.password_hash, password);
    const locked = Boolean(admin?.locked_until && admin.locked_until > now);

    const fail = () => {
      if (admin && !locked) {
        db.prepare(
          `UPDATE admins SET
             locked_until = CASE WHEN failed_attempts + 1 >= @max THEN @lockUntil ELSE locked_until END,
             failed_attempts = CASE WHEN failed_attempts + 1 >= @max THEN 0 ELSE failed_attempts + 1 END
           WHERE id = @id`
        ).run({ max: config.loginMaxFailures, lockUntil: now + config.loginLockMs, id: admin.id });
      }
      audit(db, { adminId: admin?.id ?? null, action: locked ? 'login.blocked_locked' : 'login.failure', ip: req.ip });
      throw new HttpError(401, LOGIN_FAILED);
    };

    if (!admin || !passwordOk || locked) fail();

    if (admin.totp_secret_enc) {
      const secret = cryptoBox.decryptString(admin.totp_secret_enc, totpAad(admin.id));
      const step = verifyTotp(secret, code ?? '', { lastUsedStep: admin.last_totp_step });
      if (step === null) fail();
      db.prepare('UPDATE admins SET last_totp_step = ? WHERE id = ?').run(step, admin.id);
    }

    db.prepare('UPDATE admins SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(admin.id);
    // Never reuse a session token that existed before sign-in (session fixation).
    destroySession(db, req.cookies?.[cookieName(config)]);
    const session = createSession(db, config, admin.id);
    res.cookie(cookieName(config), session.token, cookieOptions(config));
    audit(db, { adminId: admin.id, action: 'login.success', ip: req.ip });
    res.json({ username: admin.username, csrfToken: session.csrfToken, mailEnabled: mailer.enabled });
  });

  // Everything below requires a signed-in admin and, for changes, a CSRF token.
  router.use(requireAdmin({ db, config }), requireCsrf);

  router.get('/me', (req, res) => {
    res.json({
      username: req.admin.username,
      csrfToken: req.session.csrf_token,
      mailEnabled: mailer.enabled,
      companyName: config.companyName,
      retentionDays: config.retentionDays,
      statuses: APPLICATION_STATUSES,
    });
  });

  router.post('/logout', (req, res) => {
    destroySession(db, req.cookies?.[cookieName(config)]);
    res.clearCookie(cookieName(config), { ...cookieOptions(config), maxAge: undefined });
    record(req, 'logout');
    res.json({ ok: true });
  });

  router.post('/password', async (req, res) => {
    const { currentPassword, newPassword } = parseOrThrow(passwordChangeSchema, req.body ?? {});
    const admin = db.prepare('SELECT password_hash FROM admins WHERE id = ?').get(req.admin.id);
    if (!(await verifyPassword(admin.password_hash, currentPassword))) {
      record(req, 'password.change_failed');
      throw new HttpError(400, 'Your current password is incorrect.', { currentPassword: 'Incorrect password.' });
    }
    const problem = passwordProblem(newPassword);
    if (problem) throw new HttpError(400, problem, { newPassword: problem });
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(await hashPassword(newPassword), req.admin.id);
    // Sign out every other device, then issue a fresh session for this one.
    destroyAdminSessions(db, req.admin.id);
    const session = createSession(db, config, req.admin.id);
    res.cookie(cookieName(config), session.token, cookieOptions(config));
    record(req, 'password.change');
    res.json({ csrfToken: session.csrfToken });
  });

  // ---- Jobs ----------------------------------------------------------------

  function assignQuestionIds(questions) {
    const seen = new Set();
    return questions.map((question) => {
      const id = question.id || `q_${crypto.randomBytes(4).toString('hex')}`;
      if (seen.has(id)) throw new HttpError(400, 'Each question must have a unique id.');
      seen.add(id);
      return {
        id,
        label: question.label,
        type: question.type,
        required: question.required,
        ...(question.type === 'single_choice' ? { options: question.options } : {}),
      };
    });
  }

  function loadJob(id) {
    const row = UUID.test(id) ? db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) : null;
    if (!row) throw new HttpError(404, 'Job not found.');
    return rowToJob(row);
  }

  router.get('/jobs', (req, res) => {
    const counts = new Map(
      db.prepare('SELECT job_id, COUNT(*) AS n FROM applications GROUP BY job_id').all().map((r) => [r.job_id, r.n])
    );
    const jobs = db
      .prepare('SELECT * FROM jobs ORDER BY is_open DESC, created_at DESC')
      .all()
      .map(rowToJob)
      .map((job) => ({ ...job, applicationCount: counts.get(job.id) || 0 }));
    res.json({ jobs });
  });

  router.get('/jobs/:id', (req, res) => {
    res.json({ job: loadJob(req.params.id) });
  });

  router.post('/jobs', (req, res) => {
    const data = parseOrThrow(jobSchema, req.body ?? {});
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO jobs (id, slug, title, location, employment_type, description, questions, references_required, is_open, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      makeSlug(data.title),
      data.title,
      data.location,
      data.employmentType,
      data.description,
      JSON.stringify(assignQuestionIds(data.questions)),
      data.referencesRequired,
      data.isOpen ? 1 : 0,
      now,
      now
    );
    record(req, 'job.create', id);
    res.status(201).json({ job: loadJob(id) });
  });

  router.put('/jobs/:id', (req, res) => {
    const existing = loadJob(req.params.id);
    const data = parseOrThrow(jobSchema, req.body ?? {});
    db.prepare(
      `UPDATE jobs SET title = ?, location = ?, employment_type = ?, description = ?, questions = ?,
              references_required = ?, is_open = ?, updated_at = ?
        WHERE id = ?`
    ).run(
      data.title,
      data.location,
      data.employmentType,
      data.description,
      JSON.stringify(assignQuestionIds(data.questions)),
      data.referencesRequired,
      data.isOpen ? 1 : 0,
      Date.now(),
      existing.id
    );
    record(req, 'job.update', existing.id);
    res.json({ job: loadJob(existing.id) });
  });

  router.delete('/jobs/:id', (req, res) => {
    const job = loadJob(req.params.id);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM applications WHERE job_id = ?').get(job.id);
    if (n > 0) throw new HttpError(409, 'This job has applications. Close it instead, or delete its applications first.');
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    record(req, 'job.delete', job.id);
    res.json({ ok: true });
  });

  // ---- Applications --------------------------------------------------------

  function decryptOrNull(fn) {
    try {
      return fn();
    } catch (error) {
      logger.error(`[crypto] could not decrypt a record: ${error.message}`);
      return null;
    }
  }

  function loadApplicationRow(id) {
    const row = UUID.test(id)
      ? db
          .prepare('SELECT a.*, j.title AS job_title FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?')
          .get(id)
      : null;
    if (!row) throw new HttpError(404, 'Application not found.');
    return row;
  }

  router.get('/applications', (req, res) => {
    const jobId = typeof req.query.jobId === 'string' && UUID.test(req.query.jobId) ? req.query.jobId : null;
    const status = APPLICATION_STATUSES.includes(req.query.status) ? req.query.status : null;
    const rows = db
      .prepare(
        `SELECT a.id, a.job_id, a.status, a.data_enc, a.created_at, a.updated_at, j.title AS job_title,
                (SELECT COUNT(*) FROM applications b WHERE b.email_hash = a.email_hash AND b.id <> a.id) AS other_applications,
                (SELECT COUNT(*) FROM reference_requests r WHERE r.application_id = a.id AND r.status = 'completed') AS references_received
           FROM applications a JOIN jobs j ON j.id = a.job_id
          WHERE (@jobId IS NULL OR a.job_id = @jobId) AND (@status IS NULL OR a.status = @status)
          ORDER BY a.created_at DESC
          LIMIT 1000`
      )
      .all({ jobId, status });

    const applications = rows.map((row) => {
      const data = decryptOrNull(() => cryptoBox.decryptJSON(row.data_enc, applicationAad(row.id)));
      return {
        id: row.id,
        ref: shortRef(row.id),
        jobId: row.job_id,
        jobTitle: row.job_title,
        status: row.status,
        fullName: data ? data.fullName : '[unreadable]',
        email: data ? data.email : '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        otherApplications: row.other_applications,
        referencesReceived: row.references_received,
      };
    });
    record(req, 'application.list', jobId);
    res.json({ applications });
  });

  router.get('/applications/:id', (req, res) => {
    const row = loadApplicationRow(req.params.id);
    const data = cryptoBox.decryptJSON(row.data_enc, applicationAad(row.id));

    const files = db
      .prepare('SELECT id, kind, original_name_enc, file_type, size, created_at FROM files WHERE application_id = ? ORDER BY created_at')
      .all(row.id)
      .map((file) => ({
        id: file.id,
        kind: file.kind,
        name: decryptOrNull(() => cryptoBox.decryptString(file.original_name_enc, fileNameAad(file.id))) || `document${FILE_TYPES[file.file_type].extension}`,
        fileType: file.file_type,
        size: file.size,
      }));

    const now = Date.now();
    const referenceRequests = db
      .prepare('SELECT id, referee_index, status, response_enc, created_at, expires_at, completed_at FROM reference_requests WHERE application_id = ? ORDER BY created_at')
      .all(row.id)
      .map((request) => ({
        id: request.id,
        refereeIndex: request.referee_index,
        status: request.status === 'pending' && request.expires_at <= now ? 'expired' : request.status,
        createdAt: request.created_at,
        expiresAt: request.expires_at,
        completedAt: request.completed_at,
        response: request.response_enc
          ? decryptOrNull(() => cryptoBox.decryptJSON(request.response_enc, referenceAad(request.id)))
          : null,
      }));

    const otherApplications = db
      .prepare(
        `SELECT a.id, a.status, a.created_at, j.title AS job_title FROM applications a JOIN jobs j ON j.id = a.job_id
          WHERE a.email_hash = ? AND a.id <> ? ORDER BY a.created_at DESC`
      )
      .all(row.email_hash, row.id)
      .map((other) => ({ id: other.id, ref: shortRef(other.id), status: other.status, jobTitle: other.job_title, createdAt: other.created_at }));

    record(req, 'application.view', row.id);
    res.json({
      application: {
        ...data,
        id: row.id,
        ref: shortRef(row.id),
        jobId: row.job_id,
        jobTitle: row.job_title,
        status: row.status,
        notes: row.notes_enc ? cryptoBox.decryptString(row.notes_enc, notesAad(row.id)) : '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        files,
        referenceRequests,
        otherApplications,
      },
    });
  });

  router.patch('/applications/:id', (req, res) => {
    const row = loadApplicationRow(req.params.id);
    const update = parseOrThrow(applicationUpdateSchema, req.body ?? {});
    const status = update.status ?? row.status;
    const notesEnc = update.notes === undefined ? row.notes_enc : update.notes ? cryptoBox.encryptString(update.notes, notesAad(row.id)) : null;
    db.prepare('UPDATE applications SET status = ?, notes_enc = ?, updated_at = ? WHERE id = ?').run(status, notesEnc, Date.now(), row.id);
    record(req, update.status && update.status !== row.status ? `application.status:${status}` : 'application.notes', row.id);
    res.json({ ok: true, status });
  });

  router.delete('/applications/:id', (req, res) => {
    const row = loadApplicationRow(req.params.id);
    deleteApplication(db, fileStore, row.id);
    db.pragma('wal_checkpoint(TRUNCATE)');
    record(req, 'application.delete', row.id);
    res.json({ ok: true });
  });

  // ---- Files ---------------------------------------------------------------

  router.get('/files/:id', (req, res) => {
    const file = UUID.test(req.params.id) ? db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id) : null;
    if (!file) throw new HttpError(404, 'File not found.');
    const contents = fileStore.read(file.id);
    if (crypto.createHash('sha256').update(contents).digest('hex') !== file.sha256) {
      throw new Error(`Integrity check failed for file ${file.id}`);
    }
    const type = FILE_TYPES[file.file_type];
    const name = decryptOrNull(() => cryptoBox.decryptString(file.original_name_enc, fileNameAad(file.id))) || `document${type.extension}`;
    record(req, 'file.download', file.id);
    // Always a download, never rendered in the portal's origin.
    res.attachment(name);
    res.set('Content-Type', type.contentType);
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(contents);
  });

  // ---- Reference requests --------------------------------------------------

  router.post('/applications/:id/reference-requests', async (req, res) => {
    const row = loadApplicationRow(req.params.id);
    const { refereeIndex, sendEmail } = parseOrThrow(referenceRequestSchema, req.body ?? {});
    const data = cryptoBox.decryptJSON(row.data_enc, applicationAad(row.id));
    const referee = data.references[refereeIndex];
    if (!referee) throw new HttpError(400, 'That referee does not exist on this application.');

    const token = randomToken(32);
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + config.referenceLinkDays * 24 * 60 * 60 * 1000;
    db.transaction(() => {
      // Only one live link per referee: issuing a new one cancels the old one.
      db.prepare(
        `UPDATE reference_requests SET status = 'revoked' WHERE application_id = ? AND referee_index = ? AND status = 'pending'`
      ).run(row.id, refereeIndex);
      db.prepare(
        `INSERT INTO reference_requests (id, application_id, referee_index, token_hash, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      ).run(id, row.id, refereeIndex, sha256Hex(token), now, expiresAt);
    })();
    record(req, 'reference.request', id);

    const link = `${config.publicBaseUrl}/reference#${token}`;
    let emailed = false;
    let emailError = null;
    if (sendEmail) {
      if (!mailer.enabled) {
        emailError = 'Email is not configured. Copy the link and send it yourself.';
      } else {
        try {
          const expires = new Date(expiresAt).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');
          emailed = await mailer.send({
            to: referee.email,
            subject: `Reference request from ${config.companyName}`,
            text: [
              `Dear ${singleLine(referee.name)},`,
              '',
              `${singleLine(data.fullName)} has applied for the role of "${singleLine(row.job_title)}" at ${config.companyName} and named you as a referee.`,
              '',
              'We would be grateful if you could complete a short reference using this private link:',
              link,
              '',
              `The link can be used once and expires on ${expires}. Please do not forward it.`,
              '',
              `Thank you,`,
              config.companyName,
            ].join('\n'),
          });
          record(req, 'reference.email_sent', id);
        } catch (error) {
          logger.error(`[mail] reference request failed: ${error.message}`);
          emailError = 'The email could not be sent. Copy the link and send it yourself.';
        }
      }
    }

    // The raw link is shown once, to the admin who created it. Only its hash is kept.
    res.status(201).json({ id, link, expiresAt, emailed, emailError });
  });

  router.post('/reference-requests/:id/revoke', (req, res) => {
    const id = req.params.id;
    const result = UUID.test(id)
      ? db.prepare(`UPDATE reference_requests SET status = 'revoked' WHERE id = ? AND status = 'pending'`).run(id)
      : { changes: 0 };
    if (result.changes !== 1) throw new HttpError(404, 'No active reference request found.');
    record(req, 'reference.revoke', id);
    res.json({ ok: true });
  });

  // ---- Audit log -----------------------------------------------------------

  router.get('/audit', (req, res) => {
    const entries = db
      .prepare(
        `SELECT l.id, l.action, l.target, l.ip, l.created_at, ad.username
           FROM audit_log l LEFT JOIN admins ad ON ad.id = l.admin_id
          ORDER BY l.id DESC LIMIT 300`
      )
      .all()
      .map((entry) => ({
        id: entry.id,
        action: entry.action,
        target: entry.target,
        ip: entry.ip,
        username: entry.username,
        createdAt: entry.created_at,
      }));
    res.json({ entries });
  });

  return router;
}

module.exports = { adminRoutes };
