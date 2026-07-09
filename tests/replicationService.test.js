import { describe, expect, test, beforeEach, vi } from 'vitest';

// Aislamos el servicio de su persistencia y de las dependencias que cargaría al importarse.
vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({
  default: { findById: vi.fn(), toggleIsActive: vi.fn() },
}));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({
  default: { hasReplicationStarted: vi.fn(), findByReplicationAndPopulateMessages: vi.fn() },
}));
vi.mock('../src/services/v1/ManagerService.js', () => ({
  default: { findExperimentById: vi.fn() },
}));
vi.mock('../src/utils/entity.js', () => ({
  initializeExperiment: vi.fn((e) => e),
}));
vi.mock('axios', () => ({ default: { post: vi.fn() } }));

import ReplicationRepository from '../src/repositories/v1/ReplicationRepository.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';
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

describe('getConversationsCSV', () => {
  test('agrega columnas aplanadas de replicationConfig y dataUsage con el prefijo requerido', async () => {
    SessionRepository.findByReplicationAndPopulateMessages.mockResolvedValue([
      {
        id: 'session1',
        user: { email: 'student@example.com' },
        startedAt: '2026-01-01T10:00:00.000Z',
        finishedAt: '2026-01-01T10:30:00.000Z',
        dataUsage: {
          config: {
            dataUsageConsentRequired: true,
            dataUsageConsentMessage: 'Aceptas exportar datos',
            conversationAutomatedRemoval: false,
          },
          consentStatus: 'accepted',
          decidedAt: new Date('2026-01-01T10:01:00.000Z'),
        },
        score: 0,
        evaluation: 'Buen trabajo',
        messages: [
          {
            text: 'Hola, "LEIA"',
            isLeia: false,
            timestamp: '2026-01-01T10:05:00.000Z',
          },
        ],
        replicationConfig: {
          replication: { id: 'rep1', name: 'Actividad 1', duration: 30, isRepeatable: true },
          leia: {
            id: 'leia1',
            configuration: { mode: 'chat', askSolution: true },
            runnerConfiguration: { provider: 'openai-responses', modelName: 'gpt-4.1' },
            activity: { widgets: [{ name: 'editor' }] },
          },
        },
      },
      {
        id: 'session2',
        user: null,
        startedAt: '2026-01-02T10:00:00.000Z',
        messages: [],
        replicationConfig: {
          capturedAt: new Date('2026-01-02T10:00:00.000Z'),
          replication: { id: 'rep1', name: 'Actividad 1', duration: null, isRepeatable: null },
          leia: { id: 'leia2' },
        },
      },
      {
        id: 'session3',
        user: { email: 'declined@example.com' },
        startedAt: '2026-01-03T10:00:00.000Z',
        dataUsage: {
          consentStatus: 'declined',
          internalOnly: 'secret declined value',
        },
        messages: [
          {
            text: 'Do not export this message',
            isLeia: false,
            timestamp: '2026-01-03T10:05:00.000Z',
          },
        ],
        replicationConfig: {
          replication: { id: 'rep1', name: 'Actividad privada' },
          leia: {
            id: 'leia3',
            runnerConfiguration: { modelName: 'private-model' },
          },
        },
      },
    ]);

    const csv = await ReplicationService.getConversationsCSV('rep1');
    const [headers, firstRow, secondRow] = csv.trim().split('\n');

    expect(headers).not.toContain('replicationConfig_capturedAt');
    expect(headers).not.toContain('replicationConfig_replication_id');
    expect(headers).not.toContain('replicationConfig_leia_id');
    expect(headers).not.toContain('replicationConfig_leia_activity_widgets');
    expect(headers).toContain('replicationConfig_leia_runnerConfiguration_modelName');
    expect(headers).toContain('dataUsage_consentStatus');
    expect(headers).toContain('dataUsage_config_dataUsageConsentRequired');
    expect(headers).toContain('dataUsage_decidedAt');
    expect(headers).toContain('dataUsage_automatedRemovalApplied');
    expect(headers).toContain('replicationConfig_replication_duration');
    expect(headers).toContain('replicationConfig_replication_isRepeatable');
    expect(firstRow).toContain('"Hola, ""LEIA"""');
    expect(firstRow).toContain('openai-responses');
    expect(firstRow).toContain('gpt-4.1');
    expect(firstRow).toContain('accepted');
    expect(firstRow).toContain('Aceptas exportar datos');
    expect(firstRow).toContain('2026-01-01T10:01:00.000Z');
    expect(firstRow).toContain('TRUE');
    expect(firstRow).toContain('FALSE');
    expect(secondRow).toContain('No messages');
    expect(secondRow).toContain('No limit');
    expect(secondRow).toContain('FALSE');
    expect(csv).not.toContain('declined@example.com');
    expect(csv).not.toContain('Do not export this message');
    expect(csv).not.toContain('private-model');
    expect(csv).not.toContain('secret declined value');
  });
});
