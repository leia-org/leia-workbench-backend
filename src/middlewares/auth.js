import { verifyToken } from '../utils/jwt.js';
import logger from '../utils/logger.js';
import ReplicationService from '../services/v1/ReplicationService.js';
import SessionService from '../services/v1/SessionService.js';
export function auth(req, res, next) {
  req.auth = null;

  const authorizationHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];

  logger.debug('Authorization header found');

  try {
    if (authorizationHeader) {
      const parts = authorizationHeader.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        const error = new Error('Unauthorized: Invalid token format');
        error.statusCode = 401;
        return next(error);
      }

      const token = parts[1];
      req.auth = {
        method: 'JWT',
        payload: verifyToken(token),
      };
      return next();
    } else if (apiKeyHeader) {
      if (apiKeyHeader === process.env.API_KEY) {
        req.auth = {
          method: 'API_KEY',
          payload: { role: 'read' },
        };
        return next();
      } else {
        const error = new Error('Unauthorized: Invalid API key');
        error.statusCode = 401;
        return next(error);
      }
    }
  } catch (error) {
    logger.error('Error verifying token:', error);
    error.statusCode = 401;
    return next(error);
  }
  return next();
}

export function admin(req, res, next) {
  const authorization = req.headers.authorization;
  if (!authorization) {
    const error = new Error('Authorization header missing');
    error.statusCode = 401;
    return next(error);
  }
  const parts = authorization.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    const error = new Error('Invalid authorization header format');
    error.statusCode = 401;
    return next(error);
  }
  const token = parts[1];
  try {
    const decoded = verifyToken(token);
    console.log('[AUTH][admin] Token decodificado:', decoded);
    if (decoded.role === 'admin') {
      req.user = {
        ...decoded,
        isAdmin: true
      };
      return next();
    } else {
      console.warn('[AUTH][admin] Usuario sin permisos de admin:', decoded);
      const error = new Error('Insufficient permissions');
      error.statusCode = 403;
      return next(error);
    }
  } catch (err) {
    console.error('[AUTH][admin] Token inválido o expirado:', err);
    const error = new Error('Invalid or expired token');
    error.statusCode = 401;
    return next(error);
  }
}

export async function authContext(req, res, next) {
    try {
      const authorization = req.headers.authorization;
      const shareToken = req.query.token;

      req.user = {};

      if (authorization) {
        const parts = authorization.split(' ');

        if (parts.length !== 2 || parts[0] !== 'Bearer') {
          const error = new Error('Invalid authorization header format');
          error.statusCode = 401;
          return next(error);
        }

        const decoded = verifyToken(parts[1]);

        req.user = {
          ...decoded,
          isAdmin: decoded.role === 'admin',
        };
      } else if (shareToken) {
        req.user = { shareToken };
      }

      const replicationId = req.params.id || req.body.replicationId;
      const replication = await ReplicationService.findById(replicationId);

      if (!replication) {
        const error = new Error('Replication2 not found');
        error.statusCode = 404;
        return next(error);
      }

      const replicationOwner =
        replication.experiment?.user?._id ??
        replication.experiment?.user?.id ??
        replication.experiment?.user;

      const isOwner =
        replicationOwner?.toString() === req.user.id?.toString();

      const canAccessReplication =
        req.user.isAdmin === true || isOwner;

      // checkAccess lanza "Access denied" cuando no tiene acceso
      await ReplicationService.checkAccess(
        req.params.id,
        canAccessReplication,
        req.user.shareToken
      );

      req.replication = replication;
      return next();
    } catch (error) {
      error.statusCode ??= error.status ?? 500;
      return next(error);
    }
}

export async function authContextForSession(req, res, next) {
    try {
      const authorization = req.headers.authorization;
      const shareToken = req.query.token;

      req.user = {};

      if (authorization) {
        const parts = authorization.split(' ');

        if (parts.length !== 2 || parts[0] !== 'Bearer') {
          const error = new Error('Invalid authorization header format');
          error.statusCode = 401;
          return next(error);
        }

        const decoded = verifyToken(parts[1]);

        req.user = {
          ...decoded,
          isAdmin: decoded.role === 'admin',
        };
      } else if (shareToken) {
        req.user = { shareToken };
      }

      const sessionId = req.params.id;
      const session = await SessionService.findById(sessionId);

      if (!session) {
        const error = new Error('Session not found');
        error.statusCode = 404;
        return next(error);
      }

      const replicationId = session.replication.toString();
      const replication = await ReplicationService.findById(replicationId);

      if (!replication) {
        const error = new Error('Replication not found');
        error.statusCode = 404;
        return next(error);
      }

      const replicationOwner =
        replication.experiment?.user?._id ??
        replication.experiment?.user?.id ??
        replication.experiment?.user;

      const isOwner =
        replicationOwner?.toString() === req.user.id?.toString();

      const canAccessReplication =
        req.user.isAdmin === true || isOwner;

      await ReplicationService.checkAccess(
        replicationId,
        canAccessReplication,
        req.user.shareToken
      );

      req.replication = replication;
      return next();
    } catch (error) {
      error.statusCode ??= error.status ?? 500;
      return next(error);
    }
}

export function requireAdmin(req, res, next) {
  if (req.auth?.payload?.role !== 'admin') {
    const error = new Error('Unauthorized: Admin access required');
    error.statusCode = 403;
    return next(error);
  }
  return next();
}

export function requireInstructor(req, res, next) {
  if (req.auth?.payload?.role !== 'instructor') {
    const error = new Error('Unauthorized: Instructor access required');
    error.statusCode = 403;
    return next(error);
  }
  return next();
}

export function requireAdvanced(req, res, next) {
  if (req.auth?.payload?.role !== 'advanced' && req.auth?.payload?.role !== 'admin') {
    const error = new Error('Unauthorized: Advanced access required');
    error.statusCode = 403;
    return next(error);
  }
  return next();
}

// This middleware is used to check if the user or service is authenticated
export function requireAuthentication(req, res, next) {
  if (!req.auth) {
    const error = new Error('Unauthorized: Login or API key required');
    error.statusCode = 401;
    return next(error);
  }
  return next();
}

// This middleware is used to check if the user is logged in with JWT
export function requireJwtAuthentication(req, res, next) {
  if (req.auth?.method !== 'JWT') {
    const error = new Error('Unauthorized: Login required');
    error.statusCode = 401;
    return next(error);
  }
  return next();
}
// This middleware is used to check if the request is coming from an internal service with the correct intern token
export function requireInternToken(req, res, next) {
  const internToken = req.headers['x-intern-token'];
  if (internToken !== process.env.INTERN_TOKEN) {
    const error = new Error('Unauthorized: Invalid intern token');
    error.statusCode = 401;
    return next(error);
  }
  return next();
}
// This middleware is used to check if the user is logged in with API key
export function requireApiKeyAuthentication(req, res, next) {
  if (req.auth?.method !== 'API_KEY') {
    const error = new Error('Unauthorized: API key required');
    error.statusCode = 401;
    return next(error);
  }
  return next();
}

