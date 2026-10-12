'use strict';

const { rateLimit } = require('express-rate-limit');
const { safeEqual } = require('../crypto');
const { cookieName, findSession } = require('./sessions');

/** API responses may contain personal data: never let browsers or proxies cache them. */
function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  next();
}

function requireAdmin({ db, config }) {
  return (req, res, next) => {
    const session = findSession(db, config, req.cookies?.[cookieName(config)]);
    if (!session) return res.status(401).json({ error: 'Please sign in.' });
    req.session = session;
    req.admin = { id: session.admin_id, username: session.username };
    next();
  };
}

/** Every state-changing admin request must carry the per-session CSRF token. */
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.get('x-csrf-token');
  if (!token || !req.session || !safeEqual(token, req.session.csrf_token)) {
    return res.status(403).json({ error: 'Your session has expired. Please refresh the page.' });
  }
  next();
}

function limiter(windowMs, limit, message) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message }),
  });
}

function createRateLimiters(config) {
  const minutes = (n) => n * 60 * 1000;
  return {
    apply: limiter(minutes(60), config.rateLimits.applyPerHour, 'Too many applications from your network. Please try again later.'),
    login: limiter(minutes(15), config.rateLimits.loginPer15Min, 'Too many sign-in attempts. Please wait 15 minutes.'),
    reference: limiter(minutes(15), config.rateLimits.referencePer15Min, 'Too many requests. Please try again later.'),
    publicApi: limiter(minutes(15), config.rateLimits.publicPer15Min, 'Too many requests. Please try again later.'),
    adminApi: limiter(minutes(15), config.rateLimits.adminPer15Min, 'Too many requests. Please slow down.'),
  };
}

module.exports = { noStore, requireAdmin, requireCsrf, createRateLimiters };
