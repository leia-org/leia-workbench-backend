import Joi from 'joi';

export const startSessionValidator = Joi.object({
  email: Joi.string().email().required(),
  code: Joi.string().required(),
});

export const startTestSessionValidator = Joi.object({
  replicationId: Joi.string().hex().length(24).required(),
  leiaId: Joi.string().hex().length(24).required(),
});

// `message` and `toolResults` are mutually-required (one or the other):
//   - first turn from the user: { message, tools? }
//   - continuation after a tool round-trip: { toolResults, tools? }
export const sendSessionMessageValidator = Joi.object({
  message: Joi.string(),
  tools: Joi.array().items(
    Joi.object({
      name: Joi.string().required(),
      description: Joi.string().allow('').default(''),
      parameters: Joi.object().unknown(true).default({}),
    }).unknown(true)
  ),
  toolResults: Joi.array().items(
    Joi.object({
      callId: Joi.string().required(),
      output: Joi.any().required(),
    })
  ),
}).or('message', 'toolResults');

export const saveResultAndFinishSessionValidator = Joi.object({
  result: Joi.string().required(),
});

export const saveDraftValidator = Joi.object({
  draft: Joi.string().allow('').required(),
});
