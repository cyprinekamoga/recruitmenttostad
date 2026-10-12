'use strict';

const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { HttpError, parseOrThrow } = require('../errors');
const { applicationSchema } = require('../schemas');
const { inspectDocument, cleanFileName } = require('../files');
const {
  rowToJob,
  publicJob,
  findOpenJobBySlug,
  applicationAad,
  fileNameAad,
  shortRef,
  emailIndex,
} = require('../records');

function publicRoutes({ db, config, cryptoBox, fileStore, mailer, limiters, logger }) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxUploadBytes,
      files: 2,
      fields: 1,
      parts: 3,
      fieldSize: 256 * 1024,
      fieldNameSize: 50,
      headerPairs: 50,
    },
  }).fields([
    { name: 'cv', maxCount: 1 },
    { name: 'coverLetter', maxCount: 1 },
  ]);

  router.get('/config', (req, res) => {
    res.json({
      companyName: config.companyName,
      privacyContactEmail: config.privacyContactEmail,
      retentionDays: config.retentionDays,
      maxUploadMb: Math.floor(config.maxUploadBytes / 1024 / 1024),
    });
  });

  router.get('/jobs', (req, res) => {
    const jobs = db
      .prepare('SELECT * FROM jobs WHERE is_open = 1 ORDER BY created_at DESC')
      .all()
      .map(rowToJob)
      .map(({ slug, title, location, employmentType, description, createdAt }) => ({
        slug,
        title,
        location,
        employmentType,
        summary: description.length > 220 ? `${description.slice(0, 220).trimEnd()}…` : description,
        createdAt,
      }));
    res.json({ jobs });
  });

  function loadOpenJob(req, res, next) {
    const job = findOpenJobBySlug(db, req.params.slug);
    if (!job) return res.status(404).json({ error: 'This job is not available.' });
    req.job = job;
    next();
  }

  router.get('/jobs/:slug', loadOpenJob, (req, res) => {
    res.json({ job: publicJob(req.job) });
  });

  // The job is checked before the upload is read, so files sent to closed or
  // unknown jobs are never buffered.
  router.post('/jobs/:slug/apply', limiters.apply, loadOpenJob, upload, async (req, res) => {
    const job = req.job;

    let payload;
    try {
      payload = JSON.parse(req.body?.application ?? '');
    } catch {
      throw new HttpError(400, 'The application could not be read. Please try again.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new HttpError(400, 'The application could not be read. Please try again.');
    }

    // Bots that fill in the hidden field get a convincing reply but nothing is stored.
    if (typeof payload.website === 'string' && payload.website.trim() !== '') {
      return res.status(201).json({ reference: shortRef(crypto.randomUUID()) });
    }

    const data = parseOrThrow(applicationSchema(job), payload);

    const cv = req.files?.cv?.[0];
    if (!cv) throw new HttpError(400, 'Please attach your CV.', { cv: 'Please attach your CV.' });
    const uploads = [{ kind: 'cv', file: cv }];
    const coverLetter = req.files?.coverLetter?.[0];
    if (coverLetter) uploads.push({ kind: 'cover_letter', file: coverLetter });

    for (const upload of uploads) {
      try {
        upload.fileType = inspectDocument(upload.file.buffer, upload.file.originalname);
      } catch (error) {
        if (error instanceof HttpError) error.details = { [upload.kind === 'cv' ? 'cv' : 'coverLetter']: error.message };
        throw error;
      }
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const record = {
      fullName: data.fullName,
      email: data.email,
      phone: data.phone || '',
      location: data.location || '',
      profileUrl: data.profileUrl || '',
      // Question labels are copied so later edits to the job don't change what the applicant answered.
      answers: job.questions.map((question) => ({
        questionId: question.id,
        label: question.label,
        type: question.type,
        answer: data.answers[question.id] ?? '',
      })),
      references: data.references.map((referee) => ({
        name: referee.name,
        relationship: referee.relationship,
        organisation: referee.organisation || '',
        email: referee.email,
        phone: referee.phone || '',
      })),
      consent: { given: true, at: now, retentionDays: config.retentionDays },
    };

    const stored = [];
    try {
      for (const upload of uploads) {
        const fileId = crypto.randomUUID();
        const sha256 = fileStore.save(fileId, upload.file.buffer);
        stored.push({ ...upload, fileId, sha256 });
      }

      db.transaction(() => {
        db.prepare(
          `INSERT INTO applications (id, job_id, status, email_hash, data_enc, created_at, updated_at)
           VALUES (?, ?, 'new', ?, ?, ?, ?)`
        ).run(id, job.id, emailIndex(cryptoBox, data.email), cryptoBox.encryptJSON(record, applicationAad(id)), now, now);
        const insertFile = db.prepare(
          `INSERT INTO files (id, application_id, kind, original_name_enc, file_type, size, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const file of stored) {
          const name = cleanFileName(file.file.originalname, file.fileType);
          insertFile.run(
            file.fileId,
            id,
            file.kind,
            cryptoBox.encryptString(name, fileNameAad(file.fileId)),
            file.fileType,
            file.file.size,
            file.sha256,
            now
          );
        }
      })();
    } catch (error) {
      for (const file of stored) fileStore.remove(file.fileId);
      throw error;
    }

    if (mailer.enabled && config.mail.notifyEmail) {
      mailer
        .send({
          to: config.mail.notifyEmail,
          subject: `New application: ${job.title}`,
          text: `A new application (ref ${shortRef(id)}) was received for "${job.title}".\n\nSign in to review it: ${config.publicBaseUrl}/admin\n\nFor privacy, applicant details are only available inside the portal.`,
        })
        .catch((error) => logger.error(`[mail] notification failed: ${error.message}`));
    }

    res.status(201).json({ reference: shortRef(id) });
  });

  return router;
}

module.exports = { publicRoutes };
