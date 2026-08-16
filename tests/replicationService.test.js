import { describe, expect, test, beforeEach, vi } from 'vitest';

// Aislamos el servicio de su persistencia y de las dependencias que cargaría al importarse.
vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({
  default: { create: vi.fn(), findById: vi.fn(), toggleIsActive: vi.fn() },
}));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({
  default: { hasReplicationStarted: vi.fn() },
}));
vi.mock('../src/services/v1/ManagerService.js', () => ({
  default: { findExperimentById: vi.fn() },
}));
vi.mock('../src/utils/entity.js', () => ({
  initializeExperiment: vi.fn((e) => e),
}));
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

import ReplicationRepository from '../src/repositories/v1/ReplicationRepository.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import ManagerService from '../src/services/v1/ManagerService.js';
import { initializeExperiment } from '../src/utils/entity.js';
import axios from 'axios';
import ReplicationService from '../src/services/v1/ReplicationService.js';

// Construye una replicación con LEIAs cuya configuración de runner se puede afinar por test.
function buildReplication({ isActive = false, leias = [] } = {}) {
  return { _id: 'rep1', isActive, experiment: { leias } };
}

// Configuración de runner completa y válida.
const completeConfig = { modelName: 'gpt-4.1', apiKeyId: 'key1', apiKeyRequesterId: 'userA' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('create — configuración inicial de las LEIAs', () => {
  test('inicializa el experimento con la clave y el modelo por defecto del usuario', async () => {
    const experiment = { id: 'experiment1', leias: [{ configuration: { mode: 'transcription' } }] };
    const defaultApiKey = { id: 'key1', model: 'gpt-4.1-mini', isDefault: true };
    ManagerService.findExperimentById.mockResolvedValue(experiment);
    axios.get.mockImplementation(async (url) => {
      if (url === `${process.env.AUTH_URL}/api/v1/apikeys`) {
        return { data: [{ id: 'key2', isDefault: false }, defaultApiKey] };
      }
      return {
        data: {
          apiKeyProviders: { openai: ['gpt-4.1-mini'] },
          providerProviderModuleMap: { openai: 'openai-responses' },
        },
      };
    });
    ReplicationRepository.create.mockImplementation(async (data) => data);

    await ReplicationService.create(
      { name: 'Replication', experiment: 'experiment1' },
      'Bearer token',
      'user1'
    );

    expect(ManagerService.findExperimentById).toHaveBeenCalledWith(
      'experiment1',
      'Bearer token'
    );
    expect(axios.get).toHaveBeenCalledWith(
      `${process.env.AUTH_URL}/api/v1/apikeys`,
      { headers: { Authorization: 'Bearer token' } }
    );
    expect(initializeExperiment).toHaveBeenCalledWith(
      experiment,
      defaultApiKey,
      'user1',
      'openai-responses'
    );
    expect(ReplicationRepository.create).toHaveBeenCalled();
  });
});


describe('toggleIsActive — bloqueo de activación incompleta', () => {
  test('activa la replicación cuando todas las LEIAs tienen configuración válida', async () => {
    const replication = buildReplication({
      isActive: false,
      leias: [{ runnerConfiguration: { ...completeConfig } }],
    });
    ReplicationRepository.findById.mockResolvedValue(replication);
    ReplicationRepository.toggleIsActive.mockResolvedValue({ ...replication, isActive: true });

    await ReplicationService.toggleIsActive('rep1');

    expect(ReplicationRepository.toggleIsActive).toHaveBeenCalledWith('rep1');
  });

  test('impide activar si alguna LEIA no tiene clave configurada', async () => {
    const replication = buildReplication({
      isActive: false,
      leias: [
        { runnerConfiguration: { ...completeConfig } },
        { runnerConfiguration: { modelName: 'gpt-4.1', apiKeyRequesterId: 'userA' } }, // sin apiKeyId
      ],
    });
    ReplicationRepository.findById.mockResolvedValue(replication);

    await expect(ReplicationService.toggleIsActive('rep1')).rejects.toMatchObject({ statusCode: 400 });
    // No debe intentar activar una replicación incompleta.
    expect(ReplicationRepository.toggleIsActive).not.toHaveBeenCalled();
  });

  test('impide activar si a alguna LEIA le falta el modelo', async () => {
    const replication = buildReplication({
      isActive: false,
      leias: [{ runnerConfiguration: { apiKeyId: 'key1', apiKeyRequesterId: 'userA' } }], // sin modelName
    });
    ReplicationRepository.findById.mockResolvedValue(replication);

    await expect(ReplicationService.toggleIsActive('rep1')).rejects.toMatchObject({ statusCode: 400 });
    expect(ReplicationRepository.toggleIsActive).not.toHaveBeenCalled();
  });

  test('al desactivar una replicación ya activa no se aplica la comprobación de configuración', async () => {
    // Aunque la configuración esté incompleta, desactivar siempre debe estar permitido.
    const replication = buildReplication({
      isActive: true,
      leias: [{ runnerConfiguration: { modelName: 'gpt-4.1' } }],
    });
    ReplicationRepository.findById.mockResolvedValue(replication);
    ReplicationRepository.toggleIsActive.mockResolvedValue({ ...replication, isActive: false });

    await ReplicationService.toggleIsActive('rep1');

    expect(ReplicationRepository.toggleIsActive).toHaveBeenCalledWith('rep1');
  });

  test('rechaza con 404 si la replicación no existe', async () => {
    ReplicationRepository.findById.mockResolvedValue(null);

    await expect(ReplicationService.toggleIsActive('fantasma')).rejects.toMatchObject({ statusCode: 404 });
  });
});
