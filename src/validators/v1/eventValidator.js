import Joi from 'joi';
import {
  EVENT_ACTORS,
  EVENT_SOURCES,
  EVENT_VIEWS,
  MAX_BATCH_EVENTS,
  MAX_CONTENT_LENGTH,
  getEventType,
} from '../../utils/eventTypes.js';

// The batch is validated as a whole only for its shape. Each event is then
// validated on its own (validateEvent), so one bad event is reported in the
// response instead of failing the batch — and its content never travels in a
// thrown error.
export const eventBatchValidator = Joi.object({
  // Client clock when the batch was sent, to place events on the server clock.
  sentAt: Joi.date().iso(),
  events: Joi.array().items(Joi.object().unknown(true)).min(1).max(MAX_BATCH_EVENTS).required(),
});

const envelopeValidator = Joi.object({
  clientEventId: Joi.string().min(1).max(100).required(),
  type: Joi.string().max(50).required(),
  source: Joi.string().valid(...EVENT_SOURCES).default('other'),
  actor: Joi.string().valid(...EVENT_ACTORS).default('student'),
  view: Joi.string().valid(...EVENT_VIEWS),
  clientAt: Joi.date().iso().required(),
  seq: Joi.number().integer().min(0).default(0),
  payload: Joi.object().unknown(true).default({}),
  content: Joi.string().allow('', null),
  contentTruncated: Joi.boolean().default(false),
});

const rejected = (raw, reason, message) => ({
  clientEventId: typeof raw?.clientEventId === 'string' ? raw.clientEventId.slice(0, 100) : null,
  rejected: { reason, ...(message ? { message } : {}) },
});

// Joi messages name the field and the rule, not the offending value.
const firstMessage = (error) => error.details?.[0]?.message || error.message;

/**
 * Validates one event of a batch against the envelope and its type.
 * @returns {{ event: object } | { clientEventId: string|null, rejected: { reason: string, message?: string } }}
 */
export function validateEvent(raw) {
  const envelope = envelopeValidator.validate(raw, { stripUnknown: true });
  if (envelope.error) return rejected(raw, 'validation', firstMessage(envelope.error));

  const value = envelope.value;
  const definition = getEventType(value.type);
  if (!definition) return rejected(raw, 'unknown_type');
  if (!definition.sources.includes(value.source)) {
    return rejected(raw, 'validation', `"source" ${value.source} is not valid for ${value.type}`);
  }
  if (!definition.actors.includes(value.actor)) {
    return rejected(raw, 'validation', `"actor" ${value.actor} is not valid for ${value.type}`);
  }

  const payload = definition.payload.validate(value.payload, { stripUnknown: true });
  if (payload.error) return rejected(raw, 'validation', firstMessage(payload.error));

  let content;
  let contentTruncated = false;
  if (definition.content !== 'none') {
    if (typeof value.content === 'string') {
      content = value.content;
    } else if (definition.content === 'required') {
      return rejected(raw, 'validation', '"content" is required');
    }
    if (typeof content === 'string') {
      contentTruncated = value.contentTruncated === true;
      if (content.length > MAX_CONTENT_LENGTH) {
        content = content.slice(0, MAX_CONTENT_LENGTH);
        contentTruncated = true;
      }
    }
  }

  return {
    event: {
      clientEventId: value.clientEventId,
      type: value.type,
      source: value.source,
      actor: value.actor,
      view: value.view,
      clientAt: value.clientAt,
      seq: value.seq,
      payload: definition.derive(payload.value, content),
      content,
      contentTruncated,
    },
  };
}
