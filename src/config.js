'use strict';

const fs = require('node:fs');
const path = require('node:path');

class ConfigError extends Error {}

function intFrom(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number between ${min} and ${max}`);
  }
  return value;
}

function boolFrom(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

// Hosting panels (Passenger on cPanel/Plesk, LiteSpeed) may give the app a
// socket path instead of a port number; pass that through unchanged.
function portFrom(raw) {
  if (raw === undefined || raw === '') return 3000;
  if (!/^\d+$/.test(raw)) return raw;
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new ConfigError('PORT must be between 1 and 65535');
  return port;
}

const WEB_ROOT_FOLDERS = new Set(['public_html', 'htdocs']);

function realPathOfNearestExisting(dir) {
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(fs.realpathSync(current), path.relative(current, path.resolve(dir)));
}

/**
 * The app folder holds the secret key (.env) and the data folder holds the
 * database and CVs. If either sits inside a public web folder, the web server
 * could hand them to anyone, so refuse that layout.
 */
function webRootProblem(dirs) {
  for (const dir of dirs) {
    const real = realPathOfNearestExisting(dir);
    if (real.split(path.sep).some((part) => WEB_ROOT_FOLDERS.has(part.toLowerCase()))) {
      return `${real} is inside your website's public folder, so visitors could download the secret key or applicant data. Move the app (and DATA_DIR) to a folder outside public_html, e.g. /home/<your-user>/recruitment.`;
    }
  }
  return null;
}

function trustProxyFrom(raw) {
  if (raw === undefined || raw === '' || /^(0|false|no|off)$/i.test(raw)) return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (/^(true|yes|on)$/i.test(raw)) {
    throw new ConfigError('TRUST_PROXY=true trusts any client-supplied IP. Set it to the number of proxies in front of the app (usually 1).');
  }
  return raw; // e.g. "loopback" or a list of subnets
}

/**
 * Reads configuration from environment variables and fails fast on anything
 * that would make the deployment unsafe (missing key, plain HTTP in production).
 */
function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const port = portFrom(env.PORT);

  const encryptionKey = env.DATA_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new ConfigError('DATA_ENCRYPTION_KEY is not set. Generate one with `npm run generate-key` and keep a secure backup of it.');
  }
  // At least 256 random bits, base64-encoded: what `npm run generate-key` and
  // hosting platforms' "generate value" features produce.
  if (!/^[A-Za-z0-9+/_-]{43,}={0,2}$/.test(encryptionKey) || Buffer.from(encryptionKey, 'base64').length < 32) {
    throw new ConfigError('DATA_ENCRYPTION_KEY must be at least 32 random bytes encoded as base64 (use `npm run generate-key`).');
  }

  const setupCode = env.SETUP_CODE || '';
  if (setupCode && setupCode.length < 20) {
    throw new ConfigError('SETUP_CODE must be at least 20 characters long (or leave it empty to turn browser setup off).');
  }

  // RENDER_EXTERNAL_URL is set automatically on Render, so the app works on its
  // onrender.com address before a custom domain is connected.
  let publicBaseUrl =
    env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || (isProduction ? '' : `http://localhost:${typeof port === 'number' ? port : 3000}`);
  if (!publicBaseUrl) throw new ConfigError('PUBLIC_BASE_URL is required in production, e.g. https://jobs.example.com');
  let parsedBase;
  try {
    parsedBase = new URL(publicBaseUrl);
  } catch {
    throw new ConfigError('PUBLIC_BASE_URL must be a full URL, e.g. https://jobs.example.com');
  }
  if (isProduction && parsedBase.protocol !== 'https:') {
    throw new ConfigError('PUBLIC_BASE_URL must use https:// in production. Applicant data must never travel over plain HTTP.');
  }
  publicBaseUrl = parsedBase.origin;
  const secure = parsedBase.protocol === 'https:';

  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));

  const smtpHost = env.SMTP_HOST || '';

  return Object.freeze({
    nodeEnv,
    isProduction,
    port,
    host: env.HOST || '127.0.0.1',
    publicBaseUrl,
    secureCookies: secure,
    trustProxy: trustProxyFrom(env.TRUST_PROXY),
    dataDir,
    dbFile: path.join(dataDir, 'recruitment.db'),
    uploadDir: path.join(dataDir, 'uploads'),
    encryptionKey,
    setupCode,
    companyName: env.COMPANY_NAME || 'Our Company',
    privacyContactEmail: env.PRIVACY_CONTACT_EMAIL || '',
    retentionDays: intFrom(env, 'RETENTION_DAYS', 180, { min: 0, max: 3650 }),
    referenceLinkDays: intFrom(env, 'REFERENCE_LINK_DAYS', 14, { min: 1, max: 90 }),
    maxUploadBytes: intFrom(env, 'MAX_UPLOAD_MB', 5, { min: 1, max: 20 }) * 1024 * 1024,
    sessionIdleMs: intFrom(env, 'SESSION_IDLE_MINUTES', 60, { min: 5, max: 24 * 60 }) * 60 * 1000,
    sessionMaxMs: intFrom(env, 'SESSION_MAX_HOURS', 8, { min: 1, max: 72 }) * 60 * 60 * 1000,
    loginMaxFailures: 5,
    loginLockMs: 15 * 60 * 1000,
    rateLimits: Object.freeze({
      applyPerHour: intFrom(env, 'RATE_LIMIT_APPLICATIONS_PER_HOUR', 10, { min: 1 }),
      loginPer15Min: 10,
      referencePer15Min: 30,
      publicPer15Min: 600,
      adminPer15Min: 2000,
    }),
    mail: Object.freeze({
      enabled: Boolean(smtpHost),
      host: smtpHost,
      port: intFrom(env, 'SMTP_PORT', 587, { min: 1, max: 65535 }),
      secure: boolFrom(env, 'SMTP_SECURE', false),
      requireTLS: boolFrom(env, 'SMTP_REQUIRE_TLS', true),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || '',
      notifyEmail: env.NOTIFY_EMAIL || '',
    }),
  });
}

module.exports = { loadConfig, webRootProblem, ConfigError };
