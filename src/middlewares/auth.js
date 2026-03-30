import { verifyToken } from '../utils/jwt.js';


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
