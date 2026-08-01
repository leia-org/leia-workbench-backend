import jwt from 'jsonwebtoken';

export function verifyToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET, {
    ...(process.env.JWT_ISSUER ? { issuer: process.env.JWT_ISSUER } : {}),
    ...(process.env.JWT_AUDIENCE ? { audience: process.env.JWT_AUDIENCE } : {}),
  });
  if (payload.type && payload.type !== 'access') {
    throw new Error('Access token required');
  }
  return payload;
}
