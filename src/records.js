'use strict';

const crypto = require('node:crypto');

// ---- Jobs ------------------------------------------------------------------

function rowToJob(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    location: row.location,
    employmentType: row.employment_type,
    description: row.description,
    questions: JSON.parse(row.questions),
    referencesRequired: row.references_required,
    isOpen: Boolean(row.is_open),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The subset of a job that anyone on the internet may see. */
function publicJob(job) {
  return {
    slug: job.slug,
    title: job.title,
    location: job.location,
    employmentType: job.employmentType,
    description: job.description,
    referencesRequired: job.referencesRequired,
    questions: job.questions.map(({ id, label, type, required, options }) => ({ id, label, type, required, options })),
    createdAt: job.createdAt,
  };
}

function findOpenJobBySlug(db, slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,100}$/.test(slug)) return null;
  const row = db.prepare('SELECT * FROM jobs WHERE slug = ? AND is_open = 1').get(slug);
  return row ? rowToJob(row) : null;
}

function makeSlug(title) {
  const base = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'job'}-${crypto.randomBytes(3).toString('hex')}`;
}

// ---- Applications ----------------------------------------------------------

const applicationAad = (id) => `application:${id}`;
const notesAad = (id) => `application-notes:${id}`;
const fileNameAad = (id) => `file-name:${id}`;
const referenceAad = (id) => `reference:${id}`;

/** Short, human-friendly reference shown to applicants and in the admin list. */
function shortRef(id) {
  return id.slice(0, 8).toUpperCase();
}

function emailIndex(cryptoBox, email) {
  return cryptoBox.blindIndex(email.trim().toLowerCase());
}

function deleteApplication(db, fileStore, id) {
  const fileIds = db.prepare('SELECT id FROM files WHERE application_id = ?').pluck().all(id);
  const deleted = db.transaction(() => {
    db.prepare('DELETE FROM files WHERE application_id = ?').run(id);
    db.prepare('DELETE FROM reference_requests WHERE application_id = ?').run(id);
    return db.prepare('DELETE FROM applications WHERE id = ?').run(id).changes > 0;
  })();
  for (const fileId of fileIds) fileStore.remove(fileId);
  return deleted;
}

module.exports = {
  rowToJob,
  publicJob,
  findOpenJobBySlug,
  makeSlug,
  applicationAad,
  notesAad,
  fileNameAad,
  referenceAad,
  shortRef,
  emailIndex,
  deleteApplication,
};
