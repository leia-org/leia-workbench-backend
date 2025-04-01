import Joi from 'joi';

export const startSessionValidator = Joi.object({
  email: Joi.string().email().required(),
  code: Joi.string().required(),
});

export const startTestSessionValidator = Joi.object({
  replicationId: Joi.string().hex().length(24).required(),
  leiaId: Joi.string().hex().length(24).required(),
});

export const sendSessionMessageValidator = Joi.object({
  message: Joi.string().required(),
});

export const saveResultAndFinishSessionValidator = Joi.object({
  result: Joi.string().required(),
});
