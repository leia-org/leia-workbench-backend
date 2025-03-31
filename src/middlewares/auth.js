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
  if (!token || token !== process.env.ADMIN_SECRET) {
    const error = new Error('Invalid token');
    error.statusCode = 401;
    return next(error);
  }
  next();
}
