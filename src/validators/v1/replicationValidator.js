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
  audioMode: Joi.string().valid('realtime', null).allow(null).optional(),
  realtimeConfig: Joi.object({
    model: Joi.string().optional().default('gpt-4o-realtime-preview'),
    voice: Joi.string()
      .valid('alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse')
      .optional()
      .default('marin'),
    instructions: Joi.string().allow('').optional(),
    turnDetection: Joi.object({
      type: Joi.string().valid('server_vad', 'none').optional().default('server_vad'),
      threshold: Joi.number().min(0).max(1).optional().default(0.5),
      prefix_padding_ms: Joi.number().optional().default(300),
      silence_duration_ms: Joi.number().optional().default(500),
    }).optional(),
  }).optional(),
});

export const updateReplicationFormValidator = Joi.object({
  form: Joi.string().required(),
});

export const updateSessionScoreValidator = Joi.object({
  score: Joi.number().min(0).max(100).required(),
});
