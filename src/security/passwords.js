'use strict';

const argon2 = require('argon2');

// OWASP-recommended argon2id parameters (19 MiB memory, 2 iterations).
const HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

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

function hashPassword(password) {
  return argon2.hash(password, HASH_OPTIONS);
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
    await argon2.verify(dummyHash, password);
    return false;
  }
  try {
    return await argon2.verify(storedHash, password);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, passwordProblem, MIN_LENGTH };
