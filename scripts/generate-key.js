'use strict';

const crypto = require('node:crypto');

console.log(`DATA_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}`);
console.error(
  '\nPut this line in your .env file (or your host\'s secret settings).\n' +
    'Keep a copy somewhere safe and separate from your backups, for example a password manager.\n' +
    'If this key is lost, stored applications and CVs cannot be recovered. If it leaks, rotate it.'
);
