'use strict';

const crypto = require('node:crypto');

// Ciphertext layout: [version (1 byte)][IV (12 bytes)][auth tag (16 bytes)][ciphertext]
const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH;

function deriveKey(master, purpose) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `recruitment-portal:${purpose}:v1`, 32));
}

/**
 * Field- and file-level encryption with AES-256-GCM.
 *
 * Every ciphertext is bound to the record it belongs to through "additional
 * authenticated data" (e.g. `application:<id>`), so encrypted values cannot be
 * copied from one row to another without decryption failing.
 */
function createCryptoBox(masterKeyBase64) {
  const master = Buffer.from(masterKeyBase64, 'base64');
  if (master.length !== 32) throw new Error('Encryption key must be 32 bytes');
  const encryptionKey = deriveKey(master, 'encryption');
  const indexKey = deriveKey(master, 'blind-index');
  master.fill(0);

  function encrypt(plaintext, aad) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
  }

  function decrypt(payload, aad) {
    if (!Buffer.isBuffer(payload) || payload.length < HEADER_LENGTH || payload[0] !== VERSION) {
      throw new Error('Unrecognised ciphertext');
    }
    const iv = payload.subarray(1, 1 + IV_LENGTH);
    const tag = payload.subarray(1 + IV_LENGTH, HEADER_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload.subarray(HEADER_LENGTH)), decipher.final()]);
  }

  return {
    encrypt,
    decrypt,
    encryptJSON(value, aad) {
      return encrypt(Buffer.from(JSON.stringify(value), 'utf8'), aad).toString('base64');
    },
    decryptJSON(stored, aad) {
      return JSON.parse(decrypt(Buffer.from(stored, 'base64'), aad).toString('utf8'));
    },
    encryptString(value, aad) {
      return encrypt(Buffer.from(value, 'utf8'), aad).toString('base64');
    },
    decryptString(stored, aad) {
      return decrypt(Buffer.from(stored, 'base64'), aad).toString('utf8');
    },
    /** Keyed hash for equality lookups (e.g. "has this email applied before?") without storing the value. */
    blindIndex(value) {
      return crypto.createHmac('sha256', indexKey).update(value, 'utf8').digest('hex');
    },
  };
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = { createCryptoBox, randomToken, sha256Hex, safeEqual };
