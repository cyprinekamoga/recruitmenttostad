'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Turns a zod error into field-level messages. Never echoes the submitted values back. */
function validationError(zodError) {
  const fields = {};
  for (const issue of zodError.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  return new HttpError(400, 'Some fields are missing or invalid.', fields);
}

function parseOrThrow(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

module.exports = { HttpError, validationError, parseOrThrow };
