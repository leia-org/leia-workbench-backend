import Joi from 'joi';

export const createReplicationValidator = Joi.object({
  name: Joi.string().required(),
  experiment: Joi.string().hex().length(24).required(),
  duration: Joi.number().min(1),
  isActive: Joi.boolean(),
  isRepeatable: Joi.boolean(),
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
  provider: Joi.string().valid('openai-assistant').required(),
});

export const updateReplicationFormValidator = Joi.object({
  form: Joi.string().required(),
});
