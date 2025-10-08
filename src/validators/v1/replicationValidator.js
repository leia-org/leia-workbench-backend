import Joi from 'joi';

export const createReplicationValidator = Joi.object({
  name: Joi.string().required(),
  experiment: Joi.string().hex().length(24).required(),
  duration: Joi.number().min(1),
  isActive: Joi.boolean(),
  isRepeatable: Joi.boolean(),
  form: Joi.string(),
});

export const updateReplicationNameValidator = Joi.object({
  name: Joi.string().required(),
});

export const updateReplicationDurationValidator = Joi.object({
  duration: Joi.number().min(1).required(),
});

export const updateReplicationExperimentValidator = Joi.object({
  experiment: Joi.string().hex().length(24).required(),
});

export const updateReplicationLeiaRunnerConfigurationValidator = Joi.object({
  provider: Joi.string().valid('openai-assistant', 'default').required(),
});

export const updateReplicationFormValidator = Joi.object({
  form: Joi.string().required(),
});

export const updateSessionScoreValidator = Joi.object({
  score: Joi.number().min(0).max(100).required(),
});
