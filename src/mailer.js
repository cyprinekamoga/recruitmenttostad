'use strict';

const nodemailer = require('nodemailer');

function singleLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Sends plain-text email. Notification emails to the hiring team deliberately
 * contain no applicant details: they only say that something needs attention,
 * so personal data stays inside the portal.
 */
function createMailer(config) {
  const mail = config.mail;
  if (!mail.enabled) {
    return { enabled: false, async send() { return false; } };
  }

  const transport = nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    requireTLS: mail.requireTLS && !mail.secure,
    auth: mail.user ? { user: mail.user, pass: mail.pass } : undefined,
    tls: { minVersion: 'TLSv1.2' },
  });

  return {
    enabled: true,
    async send({ to, subject, text }) {
      await transport.sendMail({
        from: mail.from || mail.user,
        to,
        subject: singleLine(subject),
        text,
      });
      return true;
    },
  };
}

module.exports = { createMailer, singleLine };
