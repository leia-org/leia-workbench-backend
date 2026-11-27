import logger from '../utils/logger.js';

// Interaction events carry clipboard text and code: their bodies are never logged.
const EVENTS_PATH = /\/interactions\/[^/]+\/events\/?$/;

const requestLogger = (req, _res, next) => {
  // Building the entry costs a full serialisation of the body, so skip it
  // unless it is going to be written.
  if (!logger.isLevelEnabled('debug')) return next();

  const logDetails = {
    method: req.method,
    url: req.originalUrl,
    headers: req.headers,
    query: req.query,
    body: EVENTS_PATH.test(req.path) ? '[interaction events omitted]' : req.body,
  };
  logger.debug(JSON.stringify(logDetails, null, 2));
  return next();
};

export default requestLogger;
