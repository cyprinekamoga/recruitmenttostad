'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Files created by this process (database, uploads) are readable by its user only.
process.umask(0o077);

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { loadConfig, webRootProblem, ConfigError } = require('./config');
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

const layoutProblem = webRootProblem([path.join(__dirname, '..'), config.dataDir]);
if (layoutProblem && config.isProduction) {
  console.error(`Refusing to start: ${layoutProblem}`);
  process.exit(1);
} else if (layoutProblem) {
  console.warn(`WARNING: ${layoutProblem}`);
}

let openDatabase;
try {
  ({ openDatabase } = require('./db'));
} catch (error) {
  console.error(error.message);
  process.exit(1);
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

const onListening = () => {
  const where = typeof config.port === 'number' ? `http://${config.host}:${config.port}` : config.port;
  console.log(`Recruitment portal listening on ${where} (public URL ${config.publicBaseUrl})`);
};
const server = typeof config.port === 'number' ? app.listen(config.port, config.host, onListening) : app.listen(config.port, onListening);
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
