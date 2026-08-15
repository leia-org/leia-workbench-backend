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
  modelName: Joi.string().required(),
  apiKeyId: Joi.string().optional().allow(null),
  audioMode: Joi.string().valid('realtime', 'luke', null).allow(null).optional(),
  hideAudioTranscription: Joi.when('audioMode', {
    is: Joi.valid('realtime', 'luke'),
    then: Joi.boolean().optional().default(false),
    otherwise: Joi.valid(null).optional().default(null),
  }),
  infographic: Joi.object({
    showToStudent: Joi.boolean().optional().default(false),
    allowDownload: Joi.any().strip(),
  }).optional(),
  lukeConfig: Joi.object({
    // provider/voice are only meaningful when audioMode === 'luke'. The
    // same lukeConfig bucket is reused by text mode (which only needs
    // `widgets`), so both fields are optional at the schema level — the
    // luke flow validates their presence at runtime when audio kicks in.
    provider: Joi.string().valid('openai', 'gemini').optional(),
    voice: Joi.string().optional(),
    // Legacy: widgets / tool functions are now authored per activity in the
    // problem definition (Designer) and read from leia.spec.problem.spec.widgets
    // at runtime. This field is kept (optional) only so pre-migration
    // replications that still carry widgets here validate on save; the
    // workbench no longer authors it.
    widgets: Joi.array()
      .items(
        Joi.object({
          widgetType: Joi.string().required(),
          slot: Joi.string().valid('left', 'right', 'main').required(),
          // Per-widget configuration (e.g. CodeEditorWidget receives the
          // problem definition: fnName, description, starter code, tests).
          // Shape is opaque to the backend — the frontend widget knows
          // how to interpret its own params.
          params: Joi.object().unknown(true).optional(),
        })
      )
      .optional(),
  }).optional(),
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
