import express from 'express';

// Interaction events arrive in batches and may carry clipboard text or code,
// so their route accepts a larger JSON body than the rest of the API. It has
// to be mounted before the global express.json(), which would otherwise
// reject the body first.
export const EVENTS_BODY_LIMIT = '512kb';
export const EVENTS_BODY_PATH = '/api/v1/interactions/:sessionId/events';

export const eventsBodyParser = express.json({ limit: EVENTS_BODY_LIMIT });
