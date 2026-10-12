'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// scrypt is built into Node.js, so there is no compiled add-on to install on the
// server. These are OWASP-recommended parameters (32 MiB of memory per hash),
// chosen to stay light enough for shared hosting.
const PARAMS = { N: 2 ** 15, r: 8, p: 3 };
const KEY_LENGTH = 32;
const MAX_MEMORY = 128 * 1024 * 1024;

const MIN_LENGTH = 12;
const MAX_LENGTH = 256;

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters.`;
  }
  if (password.length > MAX_LENGTH) return `Password must be at most ${MAX_LENGTH} characters.`;
  if (new Set(password).size < 5) return 'Password is too repetitive.';
  return null;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFC'), salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEMORY });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function checkHash(storedHash, password) {
  const [scheme, N, r, p, salt, key] = String(storedHash).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password.normalize('NFC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEMORY,
  });
  return crypto.timingSafeEqual(actual, expected);
}

let dummyHash;

/**
 * Verifies a password. When there is no stored hash (unknown username) a dummy
 * hash is still checked so response times do not reveal which usernames exist.
 */
async function verifyPassword(storedHash, password) {
  if (typeof password !== 'string' || password.length > MAX_LENGTH) return false;
  if (!storedHash) {
    dummyHash ??= await hashPassword('dummy-password-for-timing-equalisation');
    await checkHash(dummyHash, password);
    return false;
  }
  try {
    return await checkHash(storedHash, password);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, passwordProblem, MIN_LENGTH };
