import { verifyToken } from '../utils/jwt.js';
import logger from '../utils/logger.js';

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

export function authContext(req, res, next) {
  const authorization = req.headers.authorization;
  const token = req.query.token;

  if (authorization) {
    const parts = authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      try {
        const decoded = verifyToken(parts[1]);
        req.user = {
          ...decoded,
          isAdmin: decoded.role === 'admin'
        };
        return next();
      } catch (err) {
        console.error('[AUTH][authContext] Token JWT inválido o expirado:', err);
    }
    }
  }

  if (token) {
    req.user = { shareToken: token };
    return next();
  }
  const error = new Error('Authorization required: JWT or share token');
  error.statusCode = 401;
  return next(error);
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

