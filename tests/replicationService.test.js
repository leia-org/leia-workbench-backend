import { describe, expect, test, beforeEach, vi } from 'vitest';

// Aislamos el servicio de su persistencia y de las dependencias que cargaría al importarse.
vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({
  default: {
    create: vi.fn(),
    findById: vi.fn(),
    toggleIsActive: vi.fn(),
    updateAskSolution: vi.fn(),
    updateAskSolutionAndEvaluateSolution: vi.fn(),
    updateShowSolution: vi.fn(),
    updateAskSolutionAndShowSolution: vi.fn(),
  },
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
import ManagerService from '../src/services/v1/ManagerService.js';
import { initializeExperiment } from '../src/utils/entity.js';
import axios from 'axios';
import ReplicationService from '../src/services/v1/ReplicationService.js';

// Construye una replicación con LEIAs cuya configuración de runner se puede afinar por test.
function buildReplication({ isActive = false, leias = [], orchestration } = {}) {
  return { _id: 'rep1', isActive, experiment: { leias, orchestration } };
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
    expect(ReplicationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ user: 'user1' }));
  });

  test('resuelve un modelo válido para una clave por defecto heredada', async () => {
    const experiment = { id: 'experiment1', leias: [{ configuration: { mode: 'standard' } }] };
    const legacyDefaultApiKey = {
      id: 'legacy-key',
      provider: 'openai',
      isDefault: true,
    };
    ManagerService.findExperimentById.mockResolvedValue(experiment);
    axios.get.mockImplementation(async (url) => {
      if (url === `${process.env.AUTH_URL}/api/v1/apikeys`) {
        return { data: [legacyDefaultApiKey] };
      }
      return {
        data: {
          apiKeyProviders: { openai: ['gpt-5.4-mini'] },
          providerProviderModuleMap: { openai: 'openai-responses' },
        },
      };
    });
    ReplicationRepository.create.mockImplementation(async (data) => data);

    await ReplicationService.create(
      { name: 'Legacy default replication', experiment: 'experiment1' },
      'Bearer token',
      'user1'
    );

    expect(initializeExperiment).toHaveBeenCalledWith(
      experiment,
      expect.objectContaining({
        id: 'legacy-key',
        provider: 'openai',
        model: 'gpt-5.4-mini',
      }),
      'user1',
      'openai-responses'
    );
    expect(ReplicationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ user: 'user1' }));
  });

  test('rechaza crear replicación si un stage no tiene LEIAs', async () => {
    const experiment = {
      id: 'exp-empty-stage',
      stages: [
        { id: 's1', outputSources: { conversation: null, submitedSolution: null, problem: null }, orchestration: { mode: 'single' } },
        { id: 's2', outputSources: { conversation: null, submitedSolution: null, problem: null }, orchestration: { mode: 'single' } },
      ],
      leias: [
        {
          id: 'l1',
          stageId: 's1',
          configuration: { mode: 'standard' },
          leia: { spec: { behaviour: { spec: { description: 'Stage 1' } } } },
        },
      ],
    };
    ManagerService.findExperimentById.mockResolvedValue(experiment);

    await expect(
      ReplicationService.create(
        { name: 'Empty stage replication', experiment: 'exp-empty-stage' },
        'Bearer token',
        'user1'
      )
    ).rejects.toMatchObject({ statusCode: 400, message: 'Stage 2 requires at least one LEIA' });
    expect(ReplicationRepository.create).not.toHaveBeenCalled();
  });

  test.each([
    ['conversation', '{{previousStage.outputs.conversation}}', 'conversation'],
    ['submitedSolution', '{{previousStage.outputs.submitedSolution}}', 'submitted solution'],
    ['problem', '{{previousStage.leia.problem.description}}', 'problem'],
  ])('rechaza crear replicación cuando falta la resolución de %s en un stage', async (_output, placeholder, label) => {
    const experiment = {
      id: 'exp-unresolved',
      stages: [
        { id: 's1', outputSources: { conversation: null, submitedSolution: null, problem: null }, orchestration: { mode: 'single' } },
        { id: 's2', outputSources: { conversation: null, submitedSolution: null, problem: null }, orchestration: { mode: 'single' } },
      ],
      leias: [
        {
          id: 'l1',
          stageId: 's1',
          configuration: { mode: 'standard' },
          leia: { spec: { behaviour: { spec: { description: 'Stage 1' } } } },
        },
        {
          id: 'l2',
          stageId: 's2',
          configuration: { mode: 'standard' },
          leia: { spec: { behaviour: { spec: { description: `Use ${placeholder}` } } } },
        },
      ],
    };
    ManagerService.findExperimentById.mockResolvedValue(experiment);

    await expect(
      ReplicationService.create(
        { name: 'Unresolved stage replication', experiment: 'exp-unresolved' },
        'Bearer token',
        'user1'
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      message: `Select an earlier stage for ${label} in stage 2`,
    });
    expect(ReplicationRepository.create).not.toHaveBeenCalled();
  });

  test('rechaza crear replicación para una actividad sin LEIAs', async () => {
    ManagerService.findExperimentById.mockResolvedValue({ id: 'exp-empty', leias: [] });

    await expect(
      ReplicationService.create(
        { name: 'Empty legacy replication', experiment: 'exp-empty' },
        'Bearer token',
        'user1'
      )
    ).rejects.toMatchObject({ statusCode: 400, message: 'Activity requires at least one LEIA' });
    expect(ReplicationRepository.create).not.toHaveBeenCalled();
  });

  test('permite crear replicación cuando todos los stages tienen LEIAs y sus resoluciones configuradas', async () => {
    const experiment = {
      id: 'exp-valid-staged',
      stages: [
        { id: 's1', outputSources: { conversation: null, submitedSolution: null, problem: null }, orchestration: { mode: 'single' } },
        { id: 's2', outputSources: { conversation: 's1', submitedSolution: null, problem: 's1' }, orchestration: { mode: 'single' } },
      ],
      leias: [
        {
          id: 'l1',
          stageId: 's1',
          configuration: { mode: 'standard' },
          leia: { spec: { behaviour: { spec: { description: 'Stage 1' } } } },
        },
        {
          id: 'l2',
          stageId: 's2',
          configuration: { mode: 'standard' },
          leia: {
            spec: {
              behaviour: { spec: { description: 'Check {{previousStage.outputs.conversation}}' } },
              rubric: { spec: { evaluationPrompt: 'Compare {{previousStage.leia.problem.solution}}' } },
            },
          },
        },
      ],
    };
    ManagerService.findExperimentById.mockResolvedValue(experiment);
    axios.get.mockResolvedValue({ data: [] });
    ReplicationRepository.create.mockImplementation(async (data) => data);

    await ReplicationService.create(
      { name: 'Valid staged replication', experiment: 'exp-valid-staged' },
      'Bearer token',
      'user1'
    );

    expect(ReplicationRepository.create).toHaveBeenCalledOnce();
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

  test('impide activar una actividad MultiLEIA con menos de dos agentes', async () => {
    const replication = buildReplication({
      isActive: false,
      orchestration: { mode: 'multi' },
      leias: [{ runnerConfiguration: { ...completeConfig } }],
    });
    ReplicationRepository.findById.mockResolvedValue(replication);

    await expect(ReplicationService.toggleIsActive('rep1')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(ReplicationRepository.toggleIsActive).not.toHaveBeenCalled();
  });

  test('impide activar audio en una actividad MultiLEIA de texto', async () => {
    const replication = buildReplication({
      isActive: false,
      orchestration: { mode: 'multi' },
      leias: [
        { runnerConfiguration: { ...completeConfig } },
        { runnerConfiguration: { ...completeConfig, audioMode: 'luke' } },
      ],
    });
    ReplicationRepository.findById.mockResolvedValue(replication);

    await expect(ReplicationService.toggleIsActive('rep1')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(ReplicationRepository.toggleIsActive).not.toHaveBeenCalled();
  });

  test('impide activar behaviours incompatibles con el problema compartido', async () => {
    const leias = [
      {
        id: 'opening',
        runnerConfiguration: { ...completeConfig },
        leia: {
          spec: {
            problem: { spec: { process: ['game'] } },
            behaviour: { spec: { process: ['game'] } },
          },
        },
      },
      {
        id: 'problem',
        runnerConfiguration: { ...completeConfig },
        leia: {
          spec: {
            problem: { spec: { process: ['requirements-elicitation'] } },
            behaviour: { spec: { process: ['requirements-elicitation'] } },
          },
        },
      },
    ];
    const replication = buildReplication({
      isActive: false,
      orchestration: { mode: 'multi', problemLeiaId: 'problem' },
      leias,
    });
    ReplicationRepository.findById.mockResolvedValue(replication);

    await expect(ReplicationService.toggleIsActive('rep1')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(ReplicationRepository.toggleIsActive).not.toHaveBeenCalled();
  });

  test('activa MultiLEIA cuando todos los behaviours comparten el process', async () => {
    const leias = ['opening', 'problem'].map((id) => ({
      id,
      runnerConfiguration: { ...completeConfig },
      leia: {
        spec: {
          problem: { spec: { process: ['requirements-elicitation'] } },
          behaviour: { spec: { process: ['requirements-elicitation'] } },
        },
      },
    }));
    const replication = buildReplication({
      isActive: false,
      orchestration: { mode: 'multi', problemLeiaId: 'problem' },
      leias,
    });
    ReplicationRepository.findById.mockResolvedValue(replication);
    ReplicationRepository.toggleIsActive.mockResolvedValue({
      ...replication,
      isActive: true,
    });

    await ReplicationService.toggleIsActive('rep1');

    expect(ReplicationRepository.toggleIsActive).toHaveBeenCalledWith('rep1');
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

  test('impide activar si un stage citado por submitedSolution tiene askSolution desactivado', async () => {
    const replication = {
      _id: 'rep1',
      isActive: false,
      experiment: {
        stages: [
          { id: 's1', orchestration: { mode: 'single' } },
          { id: 's2', orchestration: { mode: 'single' } },
          { id: 's3', outputSources: { conversation: 's2', submitedSolution: 's1' }, orchestration: { mode: 'single' } },
        ],
        leias: [
          {
            id: 'l1',
            stageId: 's1',
            configuration: { askSolution: false, evaluateSolution: false },
            runnerConfiguration: { ...completeConfig },
            leia: { spec: { behaviour: { spec: { description: 'Solve task' } } } },
          },
          {
            id: 'l2',
            stageId: 's2',
            configuration: { askSolution: false, evaluateSolution: false },
            runnerConfiguration: { ...completeConfig },
            leia: { spec: { behaviour: { spec: { description: 'Discuss' } } } },
          },
          {
            id: 'l3',
            stageId: 's3',
            configuration: { askSolution: true, evaluateSolution: true },
            runnerConfiguration: { ...completeConfig },
            leia: {
              spec: {
                behaviour: {
                  spec: {
                    description: '{{previousStage.outputs.submitedSolution}} {{previousStage.outputs.conversation}}',
                  },
                },
              },
            },
          },
        ],
      },
    };
    ReplicationRepository.findById.mockResolvedValue(replication);

    await expect(ReplicationService.toggleIsActive('rep1')).rejects.toMatchObject({ statusCode: 400 });
    expect(ReplicationRepository.toggleIsActive).not.toHaveBeenCalled();
  });

  test('impide activar si un stage citado por conversation tiene una LEIA en modo transcription', async () => {
    const replication = {
      _id: 'rep1',
      isActive: false,
      experiment: {
        stages: [
          { id: 's1', orchestration: { mode: 'single' } },
          { id: 's2', outputSources: { conversation: 's1', submitedSolution: null }, orchestration: { mode: 'single' } },
        ],
        leias: [
          {
            id: 'l1',
            stageId: 's1',
            configuration: { mode: 'transcription', askSolution: true, evaluateSolution: false },
            runnerConfiguration: { ...completeConfig },
            leia: { spec: { behaviour: { spec: { description: 'Transcript' } } } },
          },
          {
            id: 'l2',
            stageId: 's2',
            configuration: { mode: 'standard', askSolution: true, evaluateSolution: false },
            runnerConfiguration: { ...completeConfig },
            leia: {
              spec: {
                behaviour: {
                  spec: { description: 'Review {{previousStage.outputs.conversation}}' },
                },
              },
            },
          },
        ],
      },
    };
    ReplicationRepository.findById.mockResolvedValue(replication);

    await expect(ReplicationService.toggleIsActive('rep1')).rejects.toMatchObject({ statusCode: 400 });
    expect(ReplicationRepository.toggleIsActive).not.toHaveBeenCalled();
  });
});

describe('toggleAskSolution — bloqueo por dependencia de submitedSolution entre stages', () => {
  const buildStagedReplication = ({ l1Ask = true, l2Ask = true } = {}) => ({
    _id: 'rep1',
    experiment: {
      stages: [
        { id: 's1', orchestration: { mode: 'single' } },
        { id: 's2', orchestration: { mode: 'single' } },
        { id: 's3', outputSources: { conversation: 's2', submitedSolution: 's1' }, orchestration: { mode: 'single' } },
      ],
      leias: [
        {
          id: 'l1',
          stageId: 's1',
          configuration: { askSolution: l1Ask, evaluateSolution: l1Ask },
          leia: { spec: { behaviour: { spec: { description: 'Stage 1' } } } },
        },
        {
          id: 'l2',
          stageId: 's2',
          configuration: { askSolution: l2Ask, evaluateSolution: l2Ask },
          leia: { spec: { behaviour: { spec: { description: 'Stage 2' } } } },
        },
        {
          id: 'l3',
          stageId: 's3',
          configuration: { askSolution: true, evaluateSolution: true },
          leia: {
            spec: {
              behaviour: {
                spec: {
                  description: '{{previousStage.outputs.submitedSolution}} and {{previousStage.outputs.conversation}}',
                },
              },
            },
          },
        },
      ],
    },
  });

  test('impide desactivar askSolution en un stage cuya submitedSolution cita un stage posterior', async () => {
    ReplicationRepository.findById.mockResolvedValue(buildStagedReplication());

    await expect(ReplicationService.toggleAskSolution('rep1', 'l1')).rejects.toMatchObject({ statusCode: 400 });
    expect(ReplicationRepository.updateAskSolution).not.toHaveBeenCalled();
    expect(ReplicationRepository.updateAskSolutionAndEvaluateSolution).not.toHaveBeenCalled();
  });

  test('permite desactivar askSolution en un stage del que solo se cita conversation', async () => {
    const replication = buildStagedReplication();
    ReplicationRepository.findById.mockResolvedValue(replication);
    ReplicationRepository.updateAskSolutionAndEvaluateSolution.mockResolvedValue(replication);

    await ReplicationService.toggleAskSolution('rep1', 'l2');

    expect(ReplicationRepository.updateAskSolutionAndEvaluateSolution).toHaveBeenCalledWith('rep1', 'l2', false, false);
  });

  test('permite reactivar askSolution cuando estaba desactivado en un stage requerido', async () => {
    const replication = buildStagedReplication({ l1Ask: false });
    ReplicationRepository.findById.mockResolvedValue(replication);
    ReplicationRepository.updateAskSolution.mockResolvedValue(replication);

    await ReplicationService.toggleAskSolution('rep1', 'l1');

    expect(ReplicationRepository.updateAskSolution).toHaveBeenCalledWith('rep1', 'l1', true);
  });

  test('impide activar si la etapa consumidora usa modo transcription', async () => {
    const replication = {
      _id: 'rep1',
      isActive: false,
      experiment: {
        stages: [
          { id: 's1', orchestration: { mode: 'single' } },
          { id: 's2', outputSources: { conversation: null, submitedSolution: 's1' }, orchestration: { mode: 'single' } },
        ],
        leias: [
          {
            id: 'l1',
            stageId: 's1',
            configuration: { mode: 'standard', askSolution: true, evaluateSolution: false },
            runnerConfiguration: { ...completeConfig },
            leia: { spec: { behaviour: { spec: { description: 'Stage 1' } } } },
          },
          {
            id: 'l2',
            stageId: 's2',
            configuration: { mode: 'transcription', askSolution: true, evaluateSolution: false },
            runnerConfiguration: { ...completeConfig },
            leia: {
              spec: {
                behaviour: { spec: { description: 'Review {{previousStage.outputs.submitedSolution}}' } },
              },
            },
          },
        ],
      },
    };
    ReplicationRepository.findById.mockResolvedValue(replication);

    await expect(ReplicationService.toggleIsActive('rep1')).rejects.toMatchObject({ statusCode: 400 });
    expect(ReplicationRepository.toggleIsActive).not.toHaveBeenCalled();
  });

  test('en etapas MultiLEIA exige editar askSolution en el problemLeia y valida solo problemLeia al activar', async () => {
    const multiReplication = {
      _id: 'rep1',
      isActive: false,
      experiment: {
        stages: [
          { id: 's1', orchestration: { mode: 'multi', problemLeiaId: 'l1', openingLeiaId: 'l1' } },
          { id: 's2', outputSources: { conversation: null, submitedSolution: 's1' }, orchestration: { mode: 'single' } },
        ],
        leias: [
          {
            id: 'l1',
            stageId: 's1',
            configuration: { mode: 'standard', askSolution: true, evaluateSolution: false },
            runnerConfiguration: { ...completeConfig },
            leia: {
              spec: {
                problem: { spec: { process: ['game'], solution: 'ref' } },
                behaviour: { spec: { process: ['game'], description: 'Problem owner' } },
              },
            },
          },
          {
            id: 'l2',
            stageId: 's1',
            configuration: { mode: 'standard', askSolution: false, evaluateSolution: false },
            runnerConfiguration: { ...completeConfig },
            leia: {
              spec: {
                problem: { spec: { process: ['game'] } },
                behaviour: { spec: { process: ['game'], description: 'Secondary actor' } },
              },
            },
          },
          {
            id: 'l3',
            stageId: 's2',
            configuration: { mode: 'standard', askSolution: true, evaluateSolution: false },
            runnerConfiguration: { ...completeConfig },
            leia: {
              spec: {
                behaviour: { spec: { description: 'Review {{previousStage.outputs.submitedSolution}}' } },
              },
            },
          },
        ],
      },
    };
    ReplicationRepository.findById.mockResolvedValue(multiReplication);
    ReplicationRepository.toggleIsActive.mockResolvedValue({ ...multiReplication, isActive: true });

    await expect(ReplicationService.toggleAskSolution('rep1', 'l2')).rejects.toMatchObject({ statusCode: 400 });
    await expect(ReplicationService.toggleEvaluateSolution('rep1', 'l2')).rejects.toMatchObject({ statusCode: 400 });

    // Even though secondary actor l2 has askSolution=false, problemLeia l1 has askSolution=true so activation succeeds.
    await ReplicationService.toggleIsActive('rep1');
    expect(ReplicationRepository.toggleIsActive).toHaveBeenCalledWith('rep1');
  });

  test('impide activar evaluateSolution si el problema no define solución de referencia', async () => {
    const replication = {
      _id: 'rep1',
      experiment: {
        leias: [
          {
            id: 'l1',
            configuration: { askSolution: true, evaluateSolution: false },
            leia: { spec: { problem: { spec: { description: 'Open problem' } } } },
          },
        ],
      },
    };
    ReplicationRepository.findById.mockResolvedValue(replication);

    await expect(ReplicationService.toggleEvaluateSolution('rep1', 'l1')).rejects.toMatchObject({ statusCode: 400 });
  });

  test('toggleShowSolution desactiva, reactiva con askSolution y valida referencia / MultiLEIA', async () => {
    const withSolution = {
      _id: 'rep1',
      experiment: {
        leias: [
          {
            id: 'l1',
            configuration: { askSolution: true, showSolution: true },
            leia: { spec: { problem: { spec: { solution: 'Ref answer' } } } },
          },
        ],
      },
    };
    ReplicationRepository.findById.mockResolvedValue(withSolution);
    ReplicationRepository.updateShowSolution.mockResolvedValue(withSolution);
    await ReplicationService.toggleShowSolution('rep1', 'l1');
    expect(ReplicationRepository.updateShowSolution).toHaveBeenCalledWith('rep1', 'l1', false);

    // Activar showSolution cuando askSolution es false también activa askSolution.
    const askDisabled = {
      _id: 'rep1',
      experiment: {
        leias: [
          {
            id: 'l1',
            configuration: { askSolution: false, showSolution: false },
            leia: { spec: { problem: { spec: { solution: 'Ref answer' } } } },
          },
        ],
      },
    };
    ReplicationRepository.findById.mockResolvedValue(askDisabled);
    ReplicationRepository.updateAskSolutionAndShowSolution.mockResolvedValue(askDisabled);
    await ReplicationService.toggleShowSolution('rep1', 'l1');
    expect(ReplicationRepository.updateAskSolutionAndShowSolution).toHaveBeenCalledWith('rep1', 'l1', true, true);

    // Impide activar showSolution sin solución de referencia.
    const withoutSolution = {
      _id: 'rep1',
      experiment: {
        leias: [
          {
            id: 'l1',
            configuration: { askSolution: true, showSolution: false },
            leia: { spec: { problem: { spec: { description: 'Open problem' } } } },
          },
        ],
      },
    };
    ReplicationRepository.findById.mockResolvedValue(withoutSolution);
    await expect(ReplicationService.toggleShowSolution('rep1', 'l1')).rejects.toMatchObject({ statusCode: 400 });

    // Impide modificar showSolution en un actor secundario de una etapa MultiLEIA.
    const multiReplication = {
      _id: 'rep1',
      experiment: {
        stages: [{ id: 's1', orchestration: { mode: 'multi', problemLeiaId: 'l1', openingLeiaId: 'l1' } }],
        leias: [
          { id: 'l1', stageId: 's1', configuration: { askSolution: true, showSolution: true }, leia: { spec: { problem: { spec: { solution: 'ref' } } } } },
          { id: 'l2', stageId: 's1', configuration: { askSolution: false, showSolution: false }, leia: { spec: { problem: { spec: { solution: 'ref' } } } } },
        ],
      },
    };
    ReplicationRepository.findById.mockResolvedValue(multiReplication);
    await expect(ReplicationService.toggleShowSolution('rep1', 'l2')).rejects.toMatchObject({ statusCode: 400 });
  });
});
