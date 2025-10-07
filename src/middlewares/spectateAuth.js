import SpectatorService from '../services/v1/SpectatorService.js';
import logger from '../utils/logger.js';

export function requireSpectateToken(req, res, next) {
  const token = req.query.token || req.headers['x-spectate-token'];

  if (!token) {
    const error = new Error('Spectate token required');
    error.statusCode = 403;
    return next(error);
  }

  try {
    const decoded = SpectatorService.verifySpectateToken(token);
    req.spectateSession = decoded.sessionId;
    req.spectateReplication = decoded.replicationId;
    next();
  } catch (error) {
    logger.error('Spectate token verification failed:', error);
    next(error);
  }
}
