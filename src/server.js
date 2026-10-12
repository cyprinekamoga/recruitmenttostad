'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Files created by this process (database, uploads) are readable by its user only.
process.umask(0o077);

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { loadConfig, ConfigError } = require('./config');
const { openDatabase } = require('./db');
const { createCryptoBox } = require('./crypto');
const { createFileStore } = require('./files');
const { createMailer } = require('./mailer');
const { createApp } = require('./app');
const { runMaintenance } = require('./maintenance');

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const db = openDatabase(config.dbFile);
const cryptoBox = createCryptoBox(config.encryptionKey);
const fileStore = createFileStore({ uploadDir: config.uploadDir, cryptoBox });
const mailer = createMailer(config);
const app = createApp({ config, db, cryptoBox, fileStore, mailer });

const adminCount = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
if (adminCount === 0) console.warn('No admin account exists yet. Create one with `npm run create-admin`.');
if (!config.isProduction) console.warn('Running in development mode. Set NODE_ENV=production when deploying.');

const maintenance = () => {
  try {
    runMaintenance({ db, config, fileStore });
  } catch (error) {
    console.error(`[maintenance] failed: ${error.stack || error}`);
  }
};
maintenance();
const timer = setInterval(maintenance, 60 * 60 * 1000);
timer.unref();

const server = app.listen(config.port, config.host, () => {
  console.log(`Recruitment portal listening on http://${config.host}:${config.port} (public URL ${config.publicBaseUrl})`);
});
server.headersTimeout = 60 * 1000;
server.requestTimeout = 120 * 1000;

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10 * 1000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
