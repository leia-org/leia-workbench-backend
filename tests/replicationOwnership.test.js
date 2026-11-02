import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('../src/services/v1/ReplicationService.js', () => ({
  default: {
    getProviderAndProviderModuleForReplication: vi.fn(),
    validateApiKeyProviderForReplication: vi.fn(),
    updateLeiaRunnerConfiguration: vi.fn(),
  },
}));
vi.mock('../src/services/v1/SessionService.js', () => ({
  default: { saveScore: vi.fn() },
}));

import ReplicationService from '../src/services/v1/ReplicationService.js';
import { updateReplicationLeiaRunnerConfiguration } from '../src/controllers/v1/replicationController.js';

const buildReplication = () => ({
  _id: 'replication-1',
  experiment: {
    user: { id: 'owner-1', email: 'owner@example.com' },
    leias: [
      {
        id: 'leia-1',
        runnerConfiguration: {
          modelName: 'gpt-4.1',
          apiKeyId: 'key-1',
          audioMode: null,
        },
      },
    ],
  },
});

const runController = async ({ user, body }) => {
  const req = {
    params: { id: 'replication-1', leiaId: 'leia-1' },
    user,
    replication: buildReplication(),
    body,
  };
  const res = { json: vi.fn() };
  let nextError;

  await updateReplicationLeiaRunnerConfiguration(req, res, (error) => {
    nextError = error;
  });

  return { nextError, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  ReplicationService.getProviderAndProviderModuleForReplication.mockResolvedValue({
    provider: 'openai',
    providerDriver: 'openai-responses',
  });
  ReplicationService.validateApiKeyProviderForReplication.mockResolvedValue(true);
  ReplicationService.updateLeiaRunnerConfiguration.mockImplementation(
    async (id, leiaId, runnerConfiguration) => ({ id, leiaId, runnerConfiguration })
  );
});

describe('runner configuration — cambios de modelo y API key', () => {
  test('un visitante con enlace compartido no puede cambiar el modelo', async () => {
    const { nextError } = await runController({
      user: { shareToken: 'share-token' },
      body: { modelName: 'gemini-2.5-flash', apiKeyId: 'key-1', audioMode: null },
    });

    expect(nextError).toBeInstanceOf(Error);
    expect(nextError.statusCode).toBe(403);
    expect(ReplicationService.updateLeiaRunnerConfiguration).not.toHaveBeenCalled();
  });

  test('un visitante con enlace compartido no puede cambiar la API key', async () => {
    const { nextError } = await runController({
      user: { shareToken: 'share-token' },
      body: { modelName: 'gpt-4.1', apiKeyId: 'another-key', audioMode: null },
    });

    expect(nextError).toBeInstanceOf(Error);
    expect(nextError.statusCode).toBe(403);
    expect(ReplicationService.updateLeiaRunnerConfiguration).not.toHaveBeenCalled();
  });

  test('un visitante con enlace compartido puede cambiar el resto de la configuración', async () => {
    const { nextError } = await runController({
      user: { shareToken: 'share-token' },
      body: { modelName: 'gpt-4.1', apiKeyId: 'key-1', audioMode: 'realtime' },
    });

    expect(nextError).toBeUndefined();
    expect(ReplicationService.updateLeiaRunnerConfiguration).toHaveBeenCalledTimes(1);
  });

  test('el propietario puede cambiar el modelo', async () => {
    const { nextError } = await runController({
      user: { id: 'owner-1', isAdmin: false },
      body: { modelName: 'gemini-2.5-flash', apiKeyId: 'key-1', audioMode: null },
    });

    expect(nextError).toBeUndefined();
    expect(ReplicationService.updateLeiaRunnerConfiguration).toHaveBeenCalledTimes(1);
  });

  test('un administrador puede cambiar el modelo de una replicación ajena', async () => {
    const { nextError } = await runController({
      user: { id: 'admin-1', isAdmin: true },
      body: { modelName: 'gemini-2.5-flash', apiKeyId: 'key-1', audioMode: null },
    });

    expect(nextError).toBeUndefined();
    expect(ReplicationService.updateLeiaRunnerConfiguration).toHaveBeenCalledTimes(1);
  });
});
