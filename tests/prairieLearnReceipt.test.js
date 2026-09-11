import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  createPrairieLearnReceipt,
  getLeiaReceiptJwks,
  getLeiaReceiptPrivateKey,
  verifyPrairieLearnLaunch,
} from '../src/services/v1/PrairieLearnReceiptService.js';
import { startSessionValidator } from '../src/validators/v1/interactionValidator.js';

const originalEnv = { ...process.env };
const leiaKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const prairieLearnKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('PrairieLearn asymmetric integration', () => {
  test('signs the activity binding and normalized score with LEIA RS256', () => {
    const token = createPrairieLearnReceipt(
      {
        version: 1,
        completed: true,
        sessionId: 'session-1',
        participantId: 'pl-student@prairielearn.leia.ovh',
        activityCode: 'R-LEIA',
        score: 8,
        maxScore: 10,
        normalizedScore: 0.8,
        scoreSource: 'leia-evaluation',
        finishedAt: '2026-09-05T10:00:00.000Z',
      },
      { privateKey: leiaKeys.privateKey, keyId: 'leia-key-1' }
    );

    const decoded = jwt.verify(token, leiaKeys.publicKey, {
      algorithms: ['RS256'],
      issuer: 'leia-workbench',
      audience: 'prairielearn',
      complete: true,
    });
    expect(decoded.header).toMatchObject({ alg: 'RS256', kid: 'leia-key-1' });
    expect(decoded.payload).toMatchObject({
      sessionId: 'session-1',
      participantId: 'pl-student@prairielearn.leia.ovh',
      activityCode: 'R-LEIA',
      score: 8,
      maxScore: 10,
      normalizedScore: 0.8,
    });
  });

  test('publishes the LEIA receipt public key as JWKS', () => {
    const jwks = getLeiaReceiptJwks({
      privateKey: leiaKeys.privateKey,
      keyId: 'leia-key-1',
    });

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: 'RSA',
      alg: 'RS256',
      use: 'sig',
      kid: 'leia-key-1',
    });
    expect(jwks.keys[0].n).toBeTruthy();
    expect(jwks.keys[0].e).toBeTruthy();
  });

  test('rejects missing production private-key configuration', () => {
    delete process.env.LEIA_RECEIPT_PRIVATE_KEY_BASE64;
    delete process.env.LEIA_RECEIPT_PRIVATE_KEY_FILE;
    expect(() => getLeiaReceiptPrivateKey()).toThrow('not configured');
  });

  test('accepts only a valid PrairieLearn RS256 launch', async () => {
    const launchToken = jwt.sign(
      {
        version: 1,
        participantId: 'pl-student@prairielearn.leia.ovh',
        activityCode: 'R-LEIA',
        contextId: 'context-1',
      },
      prairieLearnKeys.privateKey,
      {
        algorithm: 'RS256',
        keyid: 'prairielearn-key-1',
        issuer: 'prairielearn',
        audience: 'leia-workbench',
        subject: 'pl-student@prairielearn.leia.ovh',
        expiresIn: '5m',
      }
    );
    const value = await startSessionValidator.validateAsync({
      integration: { platform: 'prairielearn', launchToken },
    });
    await expect(
      verifyPrairieLearnLaunch(value.integration.launchToken, {
        publicKey: prairieLearnKeys.publicKey,
        keyId: 'prairielearn-key-1',
      })
    ).resolves.toMatchObject({
      participantId: 'pl-student@prairielearn.leia.ovh',
      activityCode: 'R-LEIA',
      contextId: 'context-1',
    });

    await expect(
      startSessionValidator.validateAsync({
        integration: { platform: 'unknown', launchToken },
      })
    ).rejects.toThrow();
  });

  test('rejects a tampered launch token', async () => {
    const token = jwt.sign(
      {
        version: 1,
        participantId: 'pl-student@prairielearn.leia.ovh',
        activityCode: 'R-LEIA',
        contextId: 'context-1',
      },
      prairieLearnKeys.privateKey,
      {
        algorithm: 'RS256',
        keyid: 'prairielearn-key-1',
        issuer: 'prairielearn',
        audience: 'leia-workbench',
        subject: 'pl-student@prairielearn.leia.ovh',
        expiresIn: '5m',
      }
    );

    const [header, payload, signature] = token.split('.');
    const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;

    await expect(
      verifyPrairieLearnLaunch(`${header}.${payload}.${tamperedSignature}`, {
        publicKey: prairieLearnKeys.publicKey,
        keyId: 'prairielearn-key-1',
      })
    ).rejects.toThrow('Invalid or expired');
  });

  test('rejects a launch signed with an unknown kid', async () => {
    const token = jwt.sign(
      {
        version: 1,
        participantId: 'pl-student@prairielearn.leia.ovh',
        activityCode: 'R-LEIA',
        contextId: 'context-1',
      },
      prairieLearnKeys.privateKey,
      {
        algorithm: 'RS256',
        keyid: 'unknown-key',
        issuer: 'prairielearn',
        audience: 'leia-workbench',
        subject: 'pl-student@prairielearn.leia.ovh',
        expiresIn: '5m',
      }
    );

    await expect(
      verifyPrairieLearnLaunch(token, {
        publicKey: prairieLearnKeys.publicKey,
        keyId: 'prairielearn-key-1',
      })
    ).rejects.toThrow('Invalid or expired');
  });

  test('rejects an HS256 downgrade attempt', async () => {
    const token = jwt.sign(
      {
        version: 1,
        participantId: 'pl-student@prairielearn.leia.ovh',
        activityCode: 'R-LEIA',
        contextId: 'context-1',
      },
      'a-symmetric-secret-that-must-not-be-accepted',
      {
        algorithm: 'HS256',
        keyid: 'prairielearn-key-1',
        issuer: 'prairielearn',
        audience: 'leia-workbench',
        subject: 'pl-student@prairielearn.leia.ovh',
        expiresIn: '5m',
      }
    );

    await expect(
      verifyPrairieLearnLaunch(token, {
        publicKey: prairieLearnKeys.publicKey,
        keyId: 'prairielearn-key-1',
      })
    ).rejects.toThrow('Invalid or expired');
  });
});
