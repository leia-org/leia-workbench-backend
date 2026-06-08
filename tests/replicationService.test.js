import { describe, expect, test, beforeEach, vi } from 'vitest';

// Aislamos el servicio de su persistencia y de las dependencias que cargaría al importarse.
vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({
  default: { findById: vi.fn(), toggleIsActive: vi.fn() },
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
vi.mock('axios', () => ({ default: { post: vi.fn() } }));

import ReplicationRepository from '../src/repositories/v1/ReplicationRepository.js';
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
