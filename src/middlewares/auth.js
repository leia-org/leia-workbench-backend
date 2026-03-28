
import { verifyToken } from '../utils/jwt.js';

export function admin(req, res, next) {
  console.log('[AUTH][admin] Incoming request:', req.method, req.originalUrl, 'Headers:', req.headers);
  const authorization = req.headers.authorization;
  if (!authorization) {
    console.warn('[AUTH][admin] Falta header Authorization');
    const error = new Error('Authorization header missing');
    error.statusCode = 401;
    return next(error);
  }
  const parts = authorization.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    console.warn('[AUTH][admin] Formato de header Authorization inválido:', authorization);
    const error = new Error('Invalid authorization header format');
    error.statusCode = 401;
    return next(error);
  }
  const token = parts[1];
  console.log('[AUTH][admin] Bearer token recibido:', token);

  try {
    const decoded = verifyToken(token);
    console.log('[AUTH][admin] Token decodificado:', decoded);
    if (decoded.role === 'admin') {
      req.user = decoded;
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
  console.log('[AUTH][authContext] Incoming request:', req.method, req.originalUrl, 'Headers:', req.headers);
  const authorization = req.headers.authorization;
  const token = req.query.token;

  if (authorization) {
    const parts = authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      console.log('[AUTH][authContext] Bearer token recibido:', parts[1]);
      try {
        const decoded = verifyToken(parts[1]);
        console.log('[AUTH][authContext] Token decodificado:', decoded);
        req.user = decoded;
        return next();
      } catch (err) {
        console.error('[AUTH][authContext] Token JWT inválido o expirado:', err);
        // Si el JWT es inválido, no se establece req.user, pero se continúa para verificar el token de compartición
      }
    }
  }

  if (token) {
    console.log('[AUTH][authContext] shareToken recibido por query:', token);
    req.user = { shareToken: token };
    return next();
  }

  console.warn('[AUTH][authContext] No se proporcionó JWT válido ni shareToken');
  const error = new Error('Authorization required: JWT or share token');
  error.statusCode = 401;
  return next(error);
}
