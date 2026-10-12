'use strict';

const express = require('express');
const { z } = require('zod');
const { sha256Hex } = require('../crypto');
const { HttpError, parseOrThrow } = require('../errors');
const { tokenSchema, referenceResponseSchema } = require('../schemas');
const { applicationAad, referenceAad, shortRef } = require('../records');

const INVALID_LINK = 'This reference link is invalid, has already been used, or has expired.';

/**
 * Referees reach these endpoints through a one-time link. The token sits in
 * the URL fragment (#...), which browsers never send to servers, proxies or
 * analytics, and is posted in the request body. Only its hash is stored.
 */
function referenceRoutes({ db, config, cryptoBox, mailer, logger }) {
  const router = express.Router();

  function findPending(token) {
    const row = db
      .prepare(
        `SELECT r.id, r.application_id, r.referee_index, r.expires_at, j.title AS job_title, a.data_enc
           FROM reference_requests r
           JOIN applications a ON a.id = r.application_id
           JOIN jobs j ON j.id = a.job_id
          WHERE r.token_hash = ? AND r.status = 'pending'`
      )
      .get(sha256Hex(token));
    if (!row || row.expires_at <= Date.now()) throw new HttpError(404, INVALID_LINK);
    return row;
  }

  router.post('/lookup', (req, res) => {
    const { token } = parseOrThrow(z.strictObject({ token: tokenSchema }), req.body ?? {});
    const row = findPending(token);
    const application = cryptoBox.decryptJSON(row.data_enc, applicationAad(row.application_id));
    const referee = application.references[row.referee_index];
    // Only what the referee needs for context: no contact details, answers or CV.
    res.json({
      companyName: config.companyName,
      candidateName: application.fullName,
      refereeName: referee?.name || '',
      jobTitle: row.job_title,
      expiresAt: row.expires_at,
    });
  });

  router.post('/submit', (req, res) => {
    const data = parseOrThrow(referenceResponseSchema, req.body ?? {});
    const row = findPending(data.token);
    const now = Date.now();
    const response = {
      relationship: data.relationship,
      knownFor: data.knownFor,
      strengths: data.strengths,
      development: data.development || '',
      wouldReemploy: data.wouldReemploy,
      comments: data.comments || '',
      submittedAt: now,
    };
    // The status check in the WHERE clause makes each link single-use, even under concurrent submits.
    const result = db
      .prepare(
        `UPDATE reference_requests SET status = 'completed', response_enc = ?, completed_at = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run(cryptoBox.encryptJSON(response, referenceAad(row.id)), now, row.id);
    if (result.changes !== 1) throw new HttpError(404, INVALID_LINK);
    db.prepare('UPDATE applications SET updated_at = ? WHERE id = ?').run(now, row.application_id);

    if (mailer.enabled && config.mail.notifyEmail) {
      mailer
        .send({
          to: config.mail.notifyEmail,
          subject: `Reference received: ${row.job_title}`,
          text: `A referee has submitted a reference for application ${shortRef(row.application_id)} ("${row.job_title}").\n\nSign in to read it: ${config.publicBaseUrl}/admin`,
        })
        .catch((error) => logger.error(`[mail] notification failed: ${error.message}`));
    }

    res.status(201).json({ ok: true });
  });

  return router;
}

module.exports = { referenceRoutes };
