'use strict';

const { z } = require('zod');

const QUESTION_TYPES = ['short_text', 'long_text', 'yes_no', 'single_choice'];
const APPLICATION_STATUSES = ['new', 'reviewing', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];
const MAX_REFERENCES = 5;

// Unicode letters, marks and common punctuation; blocks control characters everywhere.
const noControlChars = (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

const text = (max, { min = 0, message } = {}) => {
  let schema = z.string().trim().max(max, `Must be at most ${max} characters.`);
  if (min > 0) schema = schema.min(min, message || 'This field is required.');
  return schema.refine(noControlChars, 'Contains characters that are not allowed.');
};
const optionalText = (max) => text(max).optional();
const email = z.string().trim().max(254).pipe(z.email('Enter a valid email address.'));
const phone = z
  .string()
  .trim()
  .max(40)
  .regex(/^[0-9+()\-.\s]*$/, 'Use digits, spaces and + ( ) - only.')
  .optional();
const webUrl = z.union([
  z.literal(''),
  z.url({ protocol: /^https?$/, hostname: z.regexes.domain, error: 'Enter a full web address starting with https://' }).max(300),
]);

// ---- Jobs (admin) ----------------------------------------------------------

const questionSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
    label: text(300, { min: 1 }),
    type: z.enum(QUESTION_TYPES),
    required: z.boolean().default(false),
    options: z.array(text(100, { min: 1 })).max(20).optional(),
  })
  .superRefine((question, ctx) => {
    if (question.type === 'single_choice') {
      const options = question.options || [];
      if (options.length < 2) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Add at least two options.' });
      if (new Set(options).size !== options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique.' });
    }
  });

const jobSchema = z.strictObject({
  title: text(150, { min: 2 }),
  location: text(150).default(''),
  employmentType: text(60).default(''),
  description: text(20000, { min: 1 }),
  questions: z.array(questionSchema).max(30).default([]),
  referencesRequired: z.number().int().min(0).max(MAX_REFERENCES).default(0),
  isOpen: z.boolean().default(true),
});

// ---- Applications (public) ------------------------------------------------

const refereeSchema = z.strictObject({
  name: text(120, { min: 2 }),
  relationship: text(120, { min: 2 }),
  organisation: optionalText(120),
  email,
  phone,
});

function answerSchema(question) {
  switch (question.type) {
    case 'short_text':
    case 'long_text': {
      const max = question.type === 'short_text' ? 300 : 5000;
      return question.required ? text(max, { min: 1, message: 'This question is required.' }) : optionalText(max);
    }
    case 'yes_no':
    case 'single_choice': {
      const choices = question.type === 'yes_no' ? ['yes', 'no'] : question.options;
      const choice = z.enum(choices, { error: 'Please choose one of the options.' });
      return z.preprocess((value) => (value === '' ? undefined : value), question.required ? choice : choice.optional());
    }
    default:
      throw new Error(`Unknown question type ${question.type}`);
  }
}

/** Builds the validation schema for one job's application form. Unknown fields are rejected. */
function applicationSchema(job) {
  const answers = {};
  for (const question of job.questions) answers[question.id] = answerSchema(question);
  const minReferences = job.referencesRequired;

  return z.strictObject({
    fullName: text(120, { min: 2, message: 'Please enter your full name.' }),
    email,
    phone,
    location: optionalText(120),
    profileUrl: webUrl.optional(),
    answers: z.strictObject(answers),
    references: z
      .array(refereeSchema)
      .max(MAX_REFERENCES)
      .default([])
      .refine((list) => list.length >= minReferences, `Please provide at least ${minReferences} reference(s).`),
    consent: z.literal(true, { error: 'You must agree to the privacy notice to apply.' }),
    // Honeypot: invisible to people, often filled in by spam bots.
    website: z.string().max(200).optional(),
  });
}

// ---- References (public, via one-time link) -------------------------------

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{40,60}$/, 'Invalid link.');

const referenceResponseSchema = z.strictObject({
  token: tokenSchema,
  relationship: text(300, { min: 2 }),
  knownFor: text(100, { min: 1 }),
  strengths: text(3000, { min: 1 }),
  development: optionalText(3000),
  wouldReemploy: z.enum(['yes', 'no', 'not_applicable']),
  comments: optionalText(5000),
  confirm: z.literal(true, { error: 'Please confirm the statement above.' }),
});

// ---- Admin -----------------------------------------------------------------

const loginSchema = z.strictObject({
  username: z.string().max(64),
  password: z.string().max(256),
  code: z.string().trim().max(10).optional(),
});

const applicationUpdateSchema = z
  .strictObject({
    status: z.enum(APPLICATION_STATUSES).optional(),
    notes: text(10000).optional(),
  })
  .refine((value) => value.status !== undefined || value.notes !== undefined, 'Nothing to update.');

const referenceRequestSchema = z.strictObject({
  refereeIndex: z.number().int().min(0).max(MAX_REFERENCES - 1),
  sendEmail: z.boolean().default(false),
});

const passwordChangeSchema = z.strictObject({
  currentPassword: z.string().max(256),
  newPassword: z.string().max(256),
});

module.exports = {
  QUESTION_TYPES,
  APPLICATION_STATUSES,
  jobSchema,
  applicationSchema,
  tokenSchema,
  referenceResponseSchema,
  loginSchema,
  applicationUpdateSchema,
  referenceRequestSchema,
  passwordChangeSchema,
};
