'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./errors');

const FILE_TYPES = {
  pdf: { extension: '.pdf', contentType: 'application/pdf' },
  docx: {
    extension: '.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
};

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Works out what a file really is from its contents (the browser-supplied MIME
 * type and file name are attacker-controlled and ignored). Only PDF and Word
 * .docx are accepted, and files carrying macros or scripts are refused because
 * whoever reviews applications will open these files on their own computer.
 */
function inspectDocument(buffer, originalName) {
  const extension = path.extname(originalName || '').toLowerCase();

  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    if (extension !== '.pdf') throw new HttpError(400, 'The file extension does not match its contents. Please upload a .pdf or .docx file.');
    if (buffer.includes('/JavaScript') || buffer.includes('/Launch')) {
      throw new HttpError(400, 'This PDF contains scripts or actions. Please upload a plain PDF (for example, use "Save as PDF").');
    }
    return 'pdf';
  }

  // .docx files are ZIP archives that contain word/document.xml.
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50 && buffer.includes('word/document.xml')) {
    if (extension !== '.docx') throw new HttpError(400, 'The file extension does not match its contents. Please upload a .pdf or .docx file.');
    if (buffer.includes('vbaProject.bin') || buffer.includes('word/activeX/')) {
      throw new HttpError(400, 'Documents containing macros are not accepted. Please upload a PDF or a normal .docx file.');
    }
    return 'docx';
  }

  throw new HttpError(400, 'Only PDF and Word (.docx) documents are accepted.');
}

/** Keeps a display-safe version of the uploaded file name (no paths, control characters or quotes). */
function cleanFileName(name, fileType) {
  const base = path
    .basename(String(name || '').replace(/\\/g, '/'))
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f"<>|:*?\\/]/g, '')
    .trim()
    .slice(0, 120);
  const extension = FILE_TYPES[fileType].extension;
  const stem = base.toLowerCase().endsWith(extension) ? base.slice(0, -extension.length) : base;
  return `${stem || 'document'}${extension}`;
}

function createFileStore({ uploadDir, cryptoBox }) {
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });

  function filePath(id) {
    if (!ID_PATTERN.test(id)) throw new Error('Invalid file id');
    return path.join(uploadDir, `${id}.bin`);
  }

  return {
    /** Encrypts and writes a file; returns its SHA-256 (of the plaintext) for integrity checks. */
    save(id, buffer) {
      const encrypted = cryptoBox.encrypt(buffer, `file:${id}`);
      fs.writeFileSync(filePath(id), encrypted, { mode: 0o600, flag: 'wx' });
      return crypto.createHash('sha256').update(buffer).digest('hex');
    },
    read(id) {
      return cryptoBox.decrypt(fs.readFileSync(filePath(id)), `file:${id}`);
    },
    remove(id) {
      try {
        fs.unlinkSync(filePath(id));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    },
    /** Deletes files on disk that no database row points to (e.g. left over after a crash). */
    removeOrphans(knownIds, olderThanMs = 60 * 60 * 1000) {
      let removed = 0;
      const cutoff = Date.now() - olderThanMs;
      for (const entry of fs.readdirSync(uploadDir)) {
        const id = entry.replace(/\.bin$/, '');
        if (knownIds.has(id)) continue;
        const full = path.join(uploadDir, entry);
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed++;
        }
      }
      return removed;
    },
  };
}

module.exports = { FILE_TYPES, inspectDocument, cleanFileName, createFileStore };
