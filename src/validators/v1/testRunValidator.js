import Joi from 'joi';

export const MAX_CODE_LENGTH = 60000;
export const MAX_RESULTS = 200;
export const MAX_STRING_LENGTH = 2000;

const shortText = Joi.string().allow('', null).max(MAX_STRING_LENGTH);

// A test run reported by the code editor widget. Counters and status are
// derived on the server from `results` / `error`, so they are not accepted.
export const createTestRunValidator = Joi.object({
  clientRunId: Joi.string().max(100),
  trigger: Joi.string().valid('student', 'leia').required(),
  language: Joi.string().valid('javascript', 'python').required(),
  fnName: Joi.string().allow('').max(200).default(''),
  code: Joi.string().allow('').max(MAX_CODE_LENGTH).required(),
  codeTruncated: Joi.boolean().default(false),
  results: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().allow('').max(MAX_STRING_LENGTH).default(''),
        ok: Joi.boolean().required(),
        error: shortText,
        expected: shortText,
        actual: shortText,
      })
    )
    .max(MAX_RESULTS)
    .default([]),
  error: shortText.default(null),
  durationMs: Joi.number().min(0).max(3600000).default(0),
  clientRunAt: Joi.date().iso(),
})
  .custom((value, helpers) => {
    // A run with neither per-test results nor a suite-level error says nothing.
    if (value.results.length === 0 && !value.error) {
      return helpers.message('either "results" or "error" is required');
    }
    return value;
  });
