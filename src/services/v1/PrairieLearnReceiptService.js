import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import ReplicationService from './ReplicationService.js';
import SessionService from './SessionService.js';
import UserService from './UserService.js';

const RECEIPT_ISSUER = 'leia-workbench';
const RECEIPT_AUDIENCE = 'prairielearn';
const LAUNCH_ISSUER = 'prairielearn';
const LAUNCH_AUDIENCE = 'leia-workbench';
const JWKS_CACHE_MS = 5 * 60 * 1000;
const jwksCache = new Map();

const configurationError = (message = 'PrairieLearn asymmetric signing is not configured') => {
  const error = new Error(message);
  error.statusCode = 503;
  return error;
};

const invalidLaunchError = () => {
  const error = new Error('Invalid or expired PrairieLearn launch token');
  error.statusCode = 401;
  return error;
};

const readConfiguredKey = ({ base64Name, fileName, label }) => {
  const base64Value = process.env[base64Name];
  const configuredFile = process.env[fileName];

  try {
    if (base64Value) return Buffer.from(base64Value, 'base64').toString('utf8');
    if (configuredFile) return readFileSync(configuredFile, 'utf8');
  } catch {
    throw configurationError(`${label} could not be read`);
  }

  throw configurationError(`${label} is not configured`);
};

const assertRsaKey = (key, label, requirePrivate = false) => {
  if (key.asymmetricKeyType !== 'rsa') {
    throw configurationError(`${label} must be an RSA key`);
  }
  if (requirePrivate && key.type !== 'private') {
    throw configurationError(`${label} must be a private key`);
  }
  if ((key.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
    throw configurationError(`${label} must contain at least 2048 bits`);
  }
  return key;
};

const getKeyId = (value, environmentName) => {
  const keyId = value || process.env[environmentName];
  if (!keyId || typeof keyId !== 'string') {
    throw configurationError(`${environmentName} is not configured`);
  }
  return keyId;
};

const asPrivateKey = (value) =>
  value?.type === 'private' && value?.asymmetricKeyType ? value : createPrivateKey(value);

const asPublicKey = (value) => (value?.type === 'public' && value?.asymmetricKeyType ? value : createPublicKey(value));

export const getLeiaReceiptPrivateKey = (options = {}) => {
  try {
    const key = asPrivateKey(
      options.privateKey ||
        readConfiguredKey({
          base64Name: 'LEIA_RECEIPT_PRIVATE_KEY_BASE64',
          fileName: 'LEIA_RECEIPT_PRIVATE_KEY_FILE',
          label: 'LEIA receipt private key',
        })
    );
    return assertRsaKey(key, 'LEIA receipt private key', true);
  } catch (error) {
    if (error.statusCode === 503) throw error;
    throw configurationError('LEIA receipt private key is invalid');
  }
};

export const createPrairieLearnReceipt = (claims, options = {}) => {
  const privateKey = getLeiaReceiptPrivateKey(options);
  const keyId = getKeyId(options.keyId, 'LEIA_RECEIPT_KEY_ID');
  const issuer = options.issuer || process.env.PRAIRIELEARN_RECEIPT_ISSUER || RECEIPT_ISSUER;
  const audience = options.audience || process.env.PRAIRIELEARN_RECEIPT_AUDIENCE || RECEIPT_AUDIENCE;

  return jwt.sign(claims, privateKey, {
    algorithm: 'RS256',
    keyid: keyId,
    issuer,
    audience,
    subject: claims.sessionId,
    expiresIn: '15m',
  });
};

export const getLeiaReceiptJwks = (options = {}) => {
  const privateKey = getLeiaReceiptPrivateKey(options);
  const keyId = getKeyId(options.keyId, 'LEIA_RECEIPT_KEY_ID');
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });

  const currentKey = {
    ...jwk,
    kid: keyId,
    use: 'sig',
    alg: 'RS256',
  };
  const additionalJwks = options.additionalJwks || process.env.LEIA_RECEIPT_ADDITIONAL_JWKS_JSON;
  const additionalKeys = additionalJwks
    ? parseJwks(additionalJwks, 'LEIA additional receipt JWKS').keys.filter(
        (candidate) => candidate?.kid && candidate.kid !== keyId && candidate.kty === 'RSA'
      )
    : [];

  return { keys: [currentKey, ...additionalKeys] };
};

const parseJwks = (value, label) => {
  let jwks;
  try {
    jwks = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw configurationError(`${label} is not valid JSON`);
  }
  if (!jwks || !Array.isArray(jwks.keys)) {
    throw configurationError(`${label} must contain a keys array`);
  }
  return jwks;
};

const fetchJwks = async (url) => {
  const cached = jwksCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.jwks;

  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw configurationError('PrairieLearn launch JWKS could not be downloaded');
  }
  if (!response.ok) {
    throw configurationError(`PrairieLearn launch JWKS returned HTTP ${response.status}`);
  }

  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    throw configurationError('PrairieLearn launch JWKS is not valid JSON');
  }
  const jwks = parseJwks(responseBody, 'PrairieLearn launch JWKS');
  jwksCache.set(url, { jwks, expiresAt: Date.now() + JWKS_CACHE_MS });
  return jwks;
};

const publicKeyFromJwk = (jwks, keyId) => {
  const jwk = jwks.keys.find(
    (candidate) =>
      candidate?.kid === keyId &&
      candidate.kty === 'RSA' &&
      (!candidate.alg || candidate.alg === 'RS256') &&
      (!candidate.use || candidate.use === 'sig')
  );
  if (!jwk) throw invalidLaunchError();

  try {
    return assertRsaKey(createPublicKey({ key: jwk, format: 'jwk' }), 'PrairieLearn launch public key');
  } catch (error) {
    if (error.statusCode === 503) throw error;
    throw configurationError('PrairieLearn launch JWKS contains an invalid RSA key');
  }
};

const resolveLaunchPublicKey = async (keyId, options = {}) => {
  if (options.publicKey) {
    if (options.keyId && options.keyId !== keyId) throw invalidLaunchError();
    try {
      return assertRsaKey(asPublicKey(options.publicKey), 'PrairieLearn launch public key');
    } catch (error) {
      if (error.statusCode === 503) throw error;
      throw configurationError('PrairieLearn launch public key is invalid');
    }
  }

  if (process.env.PRAIRIELEARN_LAUNCH_JWKS_JSON) {
    return publicKeyFromJwk(parseJwks(process.env.PRAIRIELEARN_LAUNCH_JWKS_JSON, 'PrairieLearn launch JWKS'), keyId);
  }
  if (process.env.PRAIRIELEARN_LAUNCH_JWKS_URL) {
    return publicKeyFromJwk(await fetchJwks(process.env.PRAIRIELEARN_LAUNCH_JWKS_URL), keyId);
  }

  const configuredKeyId = getKeyId(undefined, 'PRAIRIELEARN_LAUNCH_KEY_ID');
  if (configuredKeyId !== keyId) throw invalidLaunchError();
  try {
    return assertRsaKey(
      createPublicKey(
        readConfiguredKey({
          base64Name: 'PRAIRIELEARN_LAUNCH_PUBLIC_KEY_BASE64',
          fileName: 'PRAIRIELEARN_LAUNCH_PUBLIC_KEY_FILE',
          label: 'PrairieLearn launch public key',
        })
      ),
      'PrairieLearn launch public key'
    );
  } catch (error) {
    if (error.statusCode === 503) throw error;
    throw configurationError('PrairieLearn launch public key is invalid');
  }
};

export const verifyPrairieLearnLaunch = async (token, options = {}) => {
  const decoded = jwt.decode(token, { complete: true });
  const header = decoded?.header;
  if (!header || header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string' || !header.kid) {
    throw invalidLaunchError();
  }

  const publicKey = await resolveLaunchPublicKey(header.kid, options);
  const issuer = options.issuer || process.env.PRAIRIELEARN_LAUNCH_ISSUER || LAUNCH_ISSUER;
  const audience = options.audience || process.env.PRAIRIELEARN_LAUNCH_AUDIENCE || LAUNCH_AUDIENCE;
  let claims;
  try {
    claims = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer,
      audience,
      clockTolerance: 30,
    });
  } catch {
    throw invalidLaunchError();
  }

  if (
    typeof claims !== 'object' ||
    claims.version !== 1 ||
    typeof claims.participantId !== 'string' ||
    !claims.participantId ||
    typeof claims.activityCode !== 'string' ||
    !claims.activityCode ||
    typeof claims.contextId !== 'string' ||
    !claims.contextId ||
    claims.sub !== claims.participantId
  ) {
    throw invalidLaunchError();
  }
  return claims;
};

class PrairieLearnReceiptService {
  assertConfigured() {
    getLeiaReceiptPrivateKey();
    getKeyId(undefined, 'LEIA_RECEIPT_KEY_ID');
  }

  async issue(sessionId) {
    const session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }
    if (session.integration?.platform !== 'prairielearn') {
      const error = new Error('Session was not launched by PrairieLearn');
      error.statusCode = 403;
      throw error;
    }
    if (!session.finishedAt) {
      const error = new Error('Session is not finished yet');
      error.statusCode = 409;
      throw error;
    }

    const [user, replication] = await Promise.all([
      UserService.findById(session.user),
      ReplicationService.findById(session.replication),
    ]);
    if (!user || !replication) {
      const error = new Error('Unable to resolve the completed LEIA session');
      error.statusCode = 500;
      throw error;
    }

    const participantId = session.integration.participantId;
    const activityCode = session.integration.activityCode;
    const contextId = session.integration.contextId;
    if (
      participantId !== user.email ||
      activityCode !== replication.code ||
      typeof contextId !== 'string' ||
      !contextId
    ) {
      const error = new Error('PrairieLearn launch binding does not match the LEIA session');
      error.statusCode = 409;
      throw error;
    }

    const hasEvaluationScore = Number.isFinite(session.score);
    const rawScore = hasEvaluationScore ? session.score : 1;
    const maxScore = hasEvaluationScore ? 10 : 1;
    const normalizedScore = Math.max(0, Math.min(1, rawScore / maxScore));

    return createPrairieLearnReceipt({
      version: 1,
      completed: true,
      sessionId: String(session.id),
      participantId,
      activityCode,
      contextId,
      score: rawScore,
      maxScore,
      normalizedScore,
      scoreSource: hasEvaluationScore ? 'leia-evaluation' : 'completion',
      finishedAt: session.finishedAt.toISOString(),
    });
  }
}

export default new PrairieLearnReceiptService();
