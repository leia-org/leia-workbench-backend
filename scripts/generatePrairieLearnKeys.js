import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(scriptDirectory, '../../.local-keys/prairielearn-leia');
const force = process.argv.includes('--force');
const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, '').replace('T', '-').slice(0, 15);
const prairieLearnKeyId = `prairielearn-launch-${timestamp}`;
const leiaKeyId = `leia-receipt-${timestamp}`;

const outputFiles = {
  prairieLearnPrivate: resolve(outputDirectory, 'prairielearn-launch-private.pem'),
  prairieLearnPublic: resolve(outputDirectory, 'prairielearn-launch-public.pem'),
  leiaPrivate: resolve(outputDirectory, 'leia-receipt-private.pem'),
  leiaPublic: resolve(outputDirectory, 'leia-receipt-public.pem'),
  prairieLearnJwks: resolve(outputDirectory, 'prairielearn-launch-jwks.json'),
  leiaJwks: resolve(outputDirectory, 'leia-receipt-jwks.json'),
  workbenchEnv: resolve(outputDirectory, 'workbench.env'),
  prairieLearnEnv: resolve(outputDirectory, 'prairielearn.env'),
};

const existingKeys = Object.values(outputFiles).some((file) => existsSync(file));
if (!force && existingKeys) {
  throw new Error(`Key files already exist in ${outputDirectory}. Use --force to rotate them.`);
}
if (force && existingKeys) {
  const backupDirectory = `${outputDirectory}.previous-${timestamp}`;
  renameSync(outputDirectory, backupDirectory);
  console.log(`Previous key set preserved in ${backupDirectory}`);
}

const generateKeys = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

const exportJwk = (publicKeyPem, keyId) => {
  return {
    keys: [
      {
        ...createPublicKey(publicKeyPem).export({ format: 'jwk' }),
        kid: keyId,
        use: 'sig',
        alg: 'RS256',
      },
    ],
  };
};

const prairieLearnKeys = generateKeys();
const leiaKeys = generateKeys();
const prairieLearnJwks = exportJwk(prairieLearnKeys.publicKey, prairieLearnKeyId);
const leiaJwks = exportJwk(leiaKeys.publicKey, leiaKeyId);
const encodePem = (pem) => Buffer.from(pem).toString('base64');

mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
writeFileSync(outputFiles.prairieLearnPrivate, prairieLearnKeys.privateKey, { mode: 0o600 });
writeFileSync(outputFiles.prairieLearnPublic, prairieLearnKeys.publicKey, { mode: 0o644 });
writeFileSync(outputFiles.leiaPrivate, leiaKeys.privateKey, { mode: 0o600 });
writeFileSync(outputFiles.leiaPublic, leiaKeys.publicKey, { mode: 0o644 });
writeFileSync(outputFiles.prairieLearnJwks, `${JSON.stringify(prairieLearnJwks, null, 2)}\n`, {
  mode: 0o644,
});
writeFileSync(outputFiles.leiaJwks, `${JSON.stringify(leiaJwks, null, 2)}\n`, { mode: 0o644 });

writeFileSync(
  outputFiles.workbenchEnv,
  [
    `LEIA_RECEIPT_PRIVATE_KEY_BASE64=${encodePem(leiaKeys.privateKey)}`,
    `LEIA_RECEIPT_KEY_ID=${leiaKeyId}`,
    `PRAIRIELEARN_LAUNCH_PUBLIC_KEY_BASE64=${encodePem(prairieLearnKeys.publicKey)}`,
    `PRAIRIELEARN_LAUNCH_KEY_ID=${prairieLearnKeyId}`,
    'PRAIRIELEARN_RECEIPT_ISSUER=leia-workbench',
    'PRAIRIELEARN_RECEIPT_AUDIENCE=prairielearn',
    'PRAIRIELEARN_LAUNCH_ISSUER=prairielearn',
    'PRAIRIELEARN_LAUNCH_AUDIENCE=leia-workbench',
    '',
  ].join('\n'),
  { mode: 0o600 }
);

writeFileSync(
  outputFiles.prairieLearnEnv,
  [
    `PRAIRIELEARN_LAUNCH_PRIVATE_KEY_BASE64=${encodePem(prairieLearnKeys.privateKey)}`,
    `PRAIRIELEARN_LAUNCH_KEY_ID=${prairieLearnKeyId}`,
    'LEIA_RECEIPT_JWKS_URL=http://host.docker.internal:3001/api/v1/interactions/integrations/prairielearn/jwks',
    'PRAIRIELEARN_RECEIPT_ISSUER=leia-workbench',
    'PRAIRIELEARN_RECEIPT_AUDIENCE=prairielearn',
    'PRAIRIELEARN_LAUNCH_ISSUER=prairielearn',
    'PRAIRIELEARN_LAUNCH_AUDIENCE=leia-workbench',
    '',
  ].join('\n'),
  { mode: 0o600 }
);

console.log(`Generated independent PrairieLearn and LEIA RSA keys in ${outputDirectory}`);
console.log(`PrairieLearn launch kid: ${prairieLearnKeyId}`);
console.log(`LEIA receipt kid: ${leiaKeyId}`);
