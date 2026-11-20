import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/models/Session.js', () => ({ default: {} }));
vi.mock('../src/models/ActivityRun.js', () => ({ default: {} }));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({
  default: { findById: vi.fn(), createStageOnce: vi.fn(), findLatestStageSession: vi.fn() },
}));
vi.mock('../src/services/v1/ActivityRunService.js', () => ({
  default: {
    findById: vi.fn(),
    findLatestByUserAndReplication: vi.fn(),
    createOnce: vi.fn(),
    attachStageSession: vi.fn(),
    markFinished: vi.fn(),
  },
}));
vi.mock('../src/services/v1/LukeService.js', () => ({
  default: { flushSessionHistory: vi.fn().mockResolvedValue(false) },
}));
vi.mock('../src/services/v1/SessionService.js', () => ({
  default: {
    findById: vi.fn(),
    finish: vi.fn(),
    finishStage: vi.fn(),
    saveResultAndFinish: vi.fn(),
    updateIsRunnerInitialized: vi.fn(),
    updateMultiLeiaState: vi.fn(),
  },
}));
vi.mock('../src/services/v1/ReplicationService.js', () => ({
  default: {
    findById: vi.fn(),
    findLeia: vi.fn(),
    recordStageAssignment: vi.fn(),
  },
}));
vi.mock('../src/services/v1/RunnerService.js', () => ({
  default: {
    initializeRunner: vi.fn(),
    initializeMultiLeia: vi.fn(),
    deleteCache: vi.fn(),
  },
}));
vi.mock('../src/services/v1/UserService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: { findBySession: vi.fn().mockResolvedValue([]) } }));
vi.mock('../src/services/v1/SupervisorService.js', () => ({ default: { observeAsync: vi.fn() } }));
vi.mock('../src/services/v1/SpectatorService.js', () => ({
  default: {
    generateSpectateToken: vi.fn().mockResolvedValue({ token: 'tok', expiresAt: new Date() }),
    generateSpectateUrl: vi.fn().mockReturnValue('http://spectate'),
  },
}));
vi.mock('../src/utils/logger.js', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { initializeExperiment } from '../src/utils/entity.js';
import InteractionService from '../src/services/v1/InteractionService.js';
import ActivityRunService from '../src/services/v1/ActivityRunService.js';
import LukeService from '../src/services/v1/LukeService.js';
import SessionService from '../src/services/v1/SessionService.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import ReplicationService from '../src/services/v1/ReplicationService.js';

describe('entity.initializeExperiment', () => {
  test('preserves transcription mode and sets evaluateSolution based on problem solution presence', () => {
    const exp = initializeExperiment({
      leias: [
        {
          configuration: { mode: 'transcription', data: { messages: [] } },
          leia: { spec: { problem: { spec: { description: 'No ref solution' } } } },
        },
        {
          configuration: {},
          leia: { spec: { problem: { spec: { solution: 'Expected answer' } } } },
        },
      ],
    });

    expect(exp.leias[0].configuration.mode).toBe('transcription');
    expect(exp.leias[0].configuration.evaluateSolution).toBe(false);
    expect(exp.leias[1].configuration.mode).toBe('standard');
    expect(exp.leias[1].configuration.evaluateSolution).toBe(true);
  });
});

describe('staged activity runtime guards & ActivityRun behavior', () => {
  const buildStagedReplication = () => ({
    id: 'rep-1',
    isActive: false,
    duration: 60,
    language: 'en',
    toJSON() {
      return { id: this.id, isActive: this.isActive, duration: this.duration, language: this.language };
    },
    experiment: {
      stages: [
        { id: 's1', outputSources: { conversation: null, submitedSolution: null }, orchestration: { mode: 'single' } },
        {
          id: 's2',
          outputSources: { conversation: 's1', submitedSolution: 's1' },
          orchestration: { mode: 'multi', maxInternalTurns: 2, problemLeiaId: 'l2' },
        },
      ],
      leias: [
        {
          id: 'l1',
          stageId: 's1',
          configuration: { mode: 'standard', askSolution: true, evaluateSolution: true },
          runnerConfiguration: { provider: 'openai-responses', modelName: 'gpt-4.1', apiKeyId: 'k1', apiKeyRequesterId: 'u1' },
          leia: {
            id: 'leia-doc-1',
            spec: {
              problem: {
                spec: {
                  solution: 'Secret reference solution',
                  solutionFormat: 'text',
                  widgets: [{ widgetType: 'codeEditor', slot: 'right' }],
                },
              },
              behaviour: {
                spec: {
                  description: 'Stage 1 instructions',
                  conversationDynamics: { stoppingCondition: { enabled: true, config: { condition: 'Done' } } },
                },
              },
            },
          },
        },
        {
          id: 'l2',
          stageId: 's2',
          configuration: { mode: 'standard', askSolution: true, evaluateSolution: false },
          runnerConfiguration: { provider: 'openai-responses', modelName: 'gpt-4.1', apiKeyId: 'k1', apiKeyRequesterId: 'u1' },
          leia: {
            id: 'leia-doc-2',
            spec: {
              problem: {
                spec: {
                  widgets: [{ widgetType: 'codeEditor', slot: 'right' }],
                },
              },
              behaviour: {
                spec: {
                  description: 'Use {{previousStage.outputs.conversation}} and {{previousStage.outputs.submitedSolution}}',
                },
              },
            },
          },
        },
        {
          id: 'l3',
          stageId: 's2',
          configuration: { mode: 'standard', askSolution: false, evaluateSolution: false },
          runnerConfiguration: { provider: 'openai-responses', modelName: 'gpt-4.1', apiKeyId: 'k1', apiKeyRequesterId: 'u1' },
          leia: {
            id: 'leia-doc-3',
            spec: {
              problem: { spec: {} },
              behaviour: { spec: { description: 'Partner actor' } },
            },
          },
        },
      ],
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    LukeService.flushSessionHistory.mockResolvedValue(false);
    ReplicationService.findById.mockResolvedValue(buildStagedReplication());
  });

  test('hides reference solution in getSessionData & rejects getSolutionAndFormat when a later stage consumes submitedSolution', async () => {
    const session = {
      id: 'sess-1',
      run: 'run-1',
      replication: 'rep-1',
      stageId: 's1',
      leia: { equals: (other) => String(other) === 'l1', toString: () => 'l1' },
      finishedAt: new Date(),
      result: 'My draft',
      interactionMode: 'single',
    };
    SessionService.findById.mockResolvedValue(session);
    ReplicationService.findLeia.mockResolvedValue(buildStagedReplication().experiment.leias[0]);

    const data = await InteractionService.getSessionData('sess-1');
    expect(data.session.runId).toBe('run-1');
    expect(data.leia.showReferenceSolution).toBe(false);
    expect(data.leia.requiresConversationForNextStage).toBe(true);

    await expect(InteractionService.getSolutionAndFormat('sess-1')).rejects.toMatchObject({ statusCode: 403 });
  });

  test('does not expose tool widgets in MultiLEIA sessions', async () => {
    const session = {
      id: 'sess-2',
      run: 'run-1',
      replication: 'rep-1',
      stageId: 's2',
      leia: { equals: (other) => String(other) === 'l2', toString: () => 'l2' },
      leias: ['l2', 'l3'],
      interactionMode: 'multi',
    };
    SessionService.findById.mockResolvedValue(session);

    const data = await InteractionService.getSessionData('sess-2');
    expect(data.leia.lukeConfig).toBeUndefined();
  });

  test('rejects finishing with 0 messages when a later stage consumes conversation, unless timer expired', async () => {
    const freshSession = {
      id: 'sess-1',
      run: 'run-1',
      replication: 'rep-1',
      stageId: 's1',
      leia: 'l1',
      startedAt: new Date(),
      messages: [],
      conversationDynamicsState: { stoppingCondition: { satisfied: true } },
    };
    SessionService.findById.mockResolvedValue(freshSession);
    ReplicationService.findLeia.mockResolvedValue(buildStagedReplication().experiment.leias[0]);

    await expect(InteractionService.finishSession('sess-1')).rejects.toMatchObject({ statusCode: 400 });

    // Expired timer bypasses both stoppingCondition and empty-conversation guard.
    const expiredSession = {
      ...freshSession,
      startedAt: new Date(Date.now() - 120_000),
      conversationDynamicsState: { stoppingCondition: { satisfied: false } },
    };
    SessionService.findById.mockResolvedValue(expiredSession);
    SessionService.finishStage.mockResolvedValue({ ...expiredSession, finishedAt: new Date() });

    const finished = await InteractionService.finishSession('sess-1');
    expect(finished.finishedAt).toBeInstanceOf(Date);
    expect(LukeService.flushSessionHistory).toHaveBeenCalledWith('sess-1');
  });

  test('allows continuing to the next stage inside an open ActivityRun even when replication.isActive is false', async () => {
    const prevSession = {
      id: 'sess-1',
      run: 'run-1',
      user: 'user-1',
      replication: 'rep-1',
      stageId: 's1',
      isTest: false,
      finishedAt: new Date(),
    };
    SessionService.findById.mockResolvedValue(prevSession);
    ActivityRunService.findById.mockResolvedValue({ id: 'run-1', finishedAt: null });
    SessionRepository.createStageOnce.mockResolvedValue({
      session: {
        id: 'sess-2',
        run: 'run-1',
        user: 'user-1',
        replication: 'rep-1',
        stageId: 's2',
        leia: 'l2',
        leias: ['l2', 'l3'],
        interactionMode: 'multi',
        isRunnerInitialized: true,
      },
      created: true,
    });

    const nextId = await InteractionService.continueStage('sess-1');
    expect(nextId).toBe('sess-2');
    expect(ActivityRunService.attachStageSession).toHaveBeenCalledWith('run-1', {
      stageId: 's2',
      stageIndex: 1,
      sessionId: 'sess-2',
    });
  });

  test('marks ActivityRun finished only when finishing the final stage', async () => {
    const finalSession = {
      id: 'sess-2',
      run: 'run-1',
      replication: 'rep-1',
      stageId: 's2',
      leia: 'l2',
      interactionMode: 'multi',
      messages: ['m1'],
    };
    const finishedAt = new Date();
    SessionService.findById.mockResolvedValue(finalSession);
    ReplicationService.findLeia.mockResolvedValue(buildStagedReplication().experiment.leias[1]);
    SessionService.finishStage.mockResolvedValue({ ...finalSession, finishedAt });

    await InteractionService.finishSession('sess-2');
    expect(ActivityRunService.markFinished).toHaveBeenCalledWith('run-1', finishedAt);
  });
});
