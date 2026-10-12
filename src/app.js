'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { HttpError } = require('./errors');
const { noStore, createRateLimiters } = require('./security/middleware');
const { publicRoutes } = require('./routes/public');
const { referenceRoutes } = require('./routes/references');
const { adminRoutes } = require('./routes/admin');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function requestLogger(logger) {
  // Logs method, path and status only: no query strings, bodies, cookies or IPs.
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      logger.info?.(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(0)}ms`);
    });
    next();
  };
}

function errorHandler(config, logger) {
  const maxMb = Math.floor(config.maxUploadBytes / 1024 / 1024);
  const uploadMessages = {
    LIMIT_FILE_SIZE: `Files must be ${maxMb} MB or smaller.`,
    LIMIT_UNEXPECTED_FILE: 'Unexpected file. Please attach your CV and, optionally, a cover letter.',
  };
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: uploadMessages[err.code] || 'The upload could not be processed.' });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...(err.details ? { fields: err.details } : {}) });
    }
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request could not be read.' });
    if (err.message === 'Multipart: Boundary not found' || /^Unexpected end of form/.test(err.message)) {
      return res.status(400).json({ error: 'The upload could not be processed.' });
    }
    // Details go to the server log only; clients get a generic message.
    logger.error?.(`[error] ${req.method} ${req.path}: ${err.stack || err}`);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  };
}

function createApp({ config, db, cryptoBox, fileStore, mailer, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(config.secureCookies ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: config.secureCookies ? { maxAge: 63072000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    })
  );
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    next();
  });
  app.use(requestLogger(logger));
  app.use(cookieParser());

  const limiters = createRateLimiters(config);
  const deps = { db, config, cryptoBox, fileStore, mailer, limiters, logger };

  app.use('/api', noStore, express.json({ limit: '100kb' }));
  app.use('/api/admin', adminRoutes(deps));
  app.use('/api/references', limiters.reference, referenceRoutes(deps));
  app.use('/api', limiters.publicApi, publicRoutes(deps));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // Private pages: keep them out of search engines and browser caches.
  app.use(['/admin', '/reference'], noStore, (req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  app.get('/jobs/:slug', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'job.html')));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], dotfiles: 'ignore', index: 'index.html' }));
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

  app.use(errorHandler(config, logger));
  return app;
}

module.exports = { createApp };
