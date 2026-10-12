'use strict';

// Usage: npm run create-admin [-- --no-2fa]
// Creates an admin account, or resets the password and authenticator secret of an existing one.
// Passwords are typed at a hidden prompt so they never end up in shell history.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

process.umask(0o077);
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createCryptoBox } = require('../src/crypto');
const { upsertAdmin } = require('../src/admins');
const { otpauthUri } = require('../src/security/totp');
const { MIN_LENGTH } = require('../src/security/passwords');

function ask(rl, question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (hidden) {
      const write = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (text) => write(text.startsWith(question) ? text : '');
      rl.question(question, (answer) => {
        rl._writeToOutput = write;
        process.stdout.write('\n');
        resolve(answer);
      });
    } else {
      rl.question(question, resolve);
    }
  });
}

async function main() {
  const config = loadConfig();
  const enableTotp = !process.argv.includes('--no-2fa');
  const db = openDatabase(config.dbFile);
  const cryptoBox = createCryptoBox(config.encryptionKey);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  try {
    const username = (await ask(rl, 'Admin username: ')).trim();
    const exists = db.prepare('SELECT 1 FROM admins WHERE username = ?').get(username);
    if (exists) {
      const answer = await ask(rl, `"${username}" already exists. Reset its password${enableTotp ? ' and authenticator' : ''}? [y/N] `);
      if (!/^y(es)?$/i.test(answer.trim())) return console.log('Nothing changed.');
    }
    const password = await ask(rl, `Password (at least ${MIN_LENGTH} characters): `, { hidden: true });
    const confirm = await ask(rl, 'Repeat password: ', { hidden: true });
    if (password !== confirm) throw new Error('Passwords do not match.');

    const { totpSecret, created } = await upsertAdmin(db, cryptoBox, { username, password, enableTotp });
    console.log(created ? `\nAdmin "${username}" created.` : `\nAdmin "${username}" updated and signed out everywhere.`);

    if (totpSecret) {
      console.log('\nTwo-factor sign-in is ON. In your authenticator app (Google Authenticator, Microsoft');
      console.log('Authenticator, 1Password, ...) choose "enter a setup key" and type this key:\n');
      console.log(`    ${totpSecret.match(/.{1,4}/g).join(' ')}\n`);
      console.log('Or paste this link into an app that accepts otpauth:// links:');
      console.log(`    ${otpauthUri({ secret: totpSecret, account: username, issuer: config.companyName })}\n`);
      console.log('This key is shown only once. Clear your terminal afterwards.');
    } else {
      console.log('\nWARNING: two-factor sign-in is OFF for this account. Anyone with the password can see all applicant data.');
    }
  } finally {
    rl.close();
    db.close();
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
