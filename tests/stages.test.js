import { beforeEach, describe, expect, test, vi } from 'vitest';
import { collectStageArtifacts, validateStages, nextStage, registerStage } from '../src/utils/stages.js';
import runtime from '../src/utils/reflectiveRuntime.cjs';

vi.mock('../src/services/v1/SessionService.js', () => ({
  default: {
    findByPreviousSession: vi.fn(),
    create: vi.fn(),
    updateIsRunnerInitialized: vi.fn(),
    updateMultiLeiaState: vi.fn(),
  },
}));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: { findBySession: vi.fn() } }));
vi.mock('../src/services/v1/RunnerService.js', () => ({
  default: { initializeRunner: vi.fn(), initializeMultiLeia: vi.fn() },
}));
import StageExecutionService from '../src/services/v1/StageExecutionService.js';
import SessionService from '../src/services/v1/SessionService.js';
import MessageService from '../src/services/v1/MessageService.js';
import RunnerService from '../src/services/v1/RunnerService.js';
import Session from '../src/models/Session.js';

const leia = (id, description = 'Hello') => ({
  id,
  configuration: {},
  leia: { spec: { behaviour: { spec: { description } }, problem: { spec: {} } } },
});
const stage = (id, type, config) => ({ id, type, version: 1, title: id, config });
const staticStage = stage('intro', 'StaticContentStage', { content: 'Read this first' });
let replication;
beforeEach(() => {
  vi.resetAllMocks();
  replication = {
    id: 'replication',
    language: 'es',
    experiment: {
      leias: [leia('one', '{{previousStage.content}}'), leia('two')],
      stages: [
        staticStage,
        stage('chat', 'LEIAStage', { leiaId: 'one' }),
        stage('group', 'MultiLEIAStage', {
          leiaIds: ['one', 'two'],
          orchestration: { maxInternalTurns: 3, problemLeiaId: 'two' },
        }),
      ],
    },
  };
  // The same template cannot demand static content when following a conversational stage.
  replication.experiment.stages[2].config.leiaIds = ['two', 'three'];
  replication.experiment.leias.push(leia('three', '{{previousStage.previousSolution}}'));
  SessionService.create.mockImplementation(async (user, rep, leiaId, isTest, options) => ({
    id: 'created',
    user,
    replication: rep,
    leia: leiaId,
    isTest,
    ...options,
  }));
  MessageService.findBySession.mockResolvedValue([{ isLeia: false, text: 'Student text' }]);
});

describe('Stage contract', () => {
  test('validates mixed sequences and artifact compatibility', () => {
    expect(() => validateStages(replication.experiment)).not.toThrow();
    replication.experiment.leias[0].leia.spec.behaviour.spec.description = '{{previousStage.previousConversation}}';
    expect(() => validateStages(replication.experiment)).toThrow(/does not produce previousConversation/);
  });
  test('rejects missing predecessors, duplicate IDs, unknown versions and missing LEIAs', () => {
    const experiment = {
      leias: [leia('one', '{{previousStage.previousSolution}}')],
      stages: [stage('first', 'LEIAStage', { leiaId: 'one' })],
    };
    expect(() => validateStages(experiment)).toThrow(/does not produce/);
    expect(() => validateStages({ stages: [staticStage, staticStage] })).toThrow(/unique stable IDs/);
    expect(() => validateStages({ stages: [{ ...staticStage, version: 2 }] })).toThrow(/Unsupported/);
    expect(() => validateStages({ stages: [stage('missing', 'LEIAStage', { leiaId: 'absent' })] })).toThrow(/requires/);
  });
  test('only reads the immediately preceding stage, including static content', () => {
    expect(nextStage(replication, { stageId: 'intro' }).id).toBe('chat');
    expect(nextStage(replication, { stageId: 'group' })).toBeNull();
    expect(collectStageArtifacts(staticStage, {})).toEqual({ content: 'Read this first' });
    expect(
      collectStageArtifacts(replication.experiment.stages[2], {
        messages: [{ text: 'A', isLeia: true }],
        session: { result: 'Answer' },
      })
    ).toEqual({ previousConversation: [{ role: 'assistant', content: 'A' }], previousSolution: 'Answer' });
  });
  test('supports new artifact producers through registration', () => {
    registerStage('QuizTestStage', { outputs: { score: 'number' }, validate() {}, artifacts: () => ({ score: 8 }) });
    const quiz = stage('quiz', 'QuizTestStage', {});
    const experiment = {
      stages: [quiz, stage('review', 'LEIAStage', { leiaId: 'reviewer' })],
      leias: [leia('reviewer', '{{previousStage.score}}')],
    };
    expect(() => validateStages(experiment)).not.toThrow();
    expect(collectStageArtifacts(quiz, {})).toEqual({ score: 8 });
  });
  test('resolves once and never interprets artifact text as a new template', () => {
    const template = leia('one', '{{previousStage.content}}').leia;
    const instance = runtime.instantiateLeia(template, { content: '$& {{previousStage.secret}}' });
    expect(instance.spec.behaviour.spec.description).toBe('$& {{previousStage.secret}}');
    expect(template.spec.behaviour.spec.description).toBe('{{previousStage.content}}');
    expect(() => runtime.instantiateLeia(template, {})).toThrow(/Unknown/);
    expect(Object.isFrozen(instance)).toBe(true);
  });
});

describe('Stage execution', () => {
  test('persists static executions without a LEIA and hides runtime inputs when serialized', async () => {
    const session = new Session({
      replication: '000000000000000000000001',
      interactionMode: 'static',
      stageId: 'intro',
      activityRunId: 'run',
      stageSnapshot: staticStage,
      previousStage: { secret: 'private' },
      stageState: { internal: true },
      stageEntries: [{ runnerConfiguration: { apiKeyId: 'private' } }],
    });
    await expect(session.validate()).resolves.toBeUndefined();
    const data = session.toJSON();
    expect(data.activityRunId).toBe('run');
    for (const key of ['stageSnapshot', 'stageState', 'stageEntries', 'previousStage'])
      expect(data[key]).toBeUndefined();
  });
  test('starts a static stage without invoking a runner', async () => {
    expect(await StageExecutionService.start(replication, 'student')).toBe('created');
    expect(SessionService.create).toHaveBeenCalledWith(
      'student',
      'replication',
      undefined,
      false,
      expect.objectContaining({
        stageId: 'intro',
        interactionMode: 'static',
        activityRunId: expect.any(String),
      })
    );
    expect(RunnerService.initializeRunner).not.toHaveBeenCalled();
  });
  test('continues in the same run with static output and a snapshot of authored input', async () => {
    const previous = {
      id: 'previous',
      user: 'student',
      replication: 'replication',
      activityRunId: 'run',
      stageId: 'intro',
      stageSnapshot: staticStage,
      finishedAt: new Date(),
    };
    await StageExecutionService.start(replication, 'student', false, previous);
    const options = SessionService.create.mock.calls[0][4];
    expect(options.activityRunId).toBe('run');
    expect(options.previousStage).toEqual({ content: 'Read this first' });
    expect(options.leiaSnapshot.spec.behaviour.spec.description).toBe('{{previousStage.content}}');
    expect(options.leiaSnapshot.spec.previousStage).toEqual({ content: 'Read this first' });
    expect(RunnerService.initializeRunner).toHaveBeenCalledOnce();
  });
  test('initializes only the selected MultiLEIA actors with stage orchestration', async () => {
    const previous = {
      id: 'previous',
      user: 'student',
      replication: 'replication',
      activityRunId: 'run',
      stageId: 'chat',
      stageSnapshot: replication.experiment.stages[1],
      result: 'My solution',
      finishedAt: new Date(),
    };
    await StageExecutionService.start(replication, 'student', false, previous);
    const [id, actors, orchestration] = RunnerService.initializeMultiLeia.mock.calls[0];
    expect(id).toBe('created');
    expect(actors.map((entry) => entry.id)).toEqual(['two', 'three']);
    expect(orchestration).toMatchObject({ maxInternalTurns: 3, problemLeiaId: 'two' });
    expect(actors[1].leia.spec.previousStage.previousSolution).toBe('My solution');
    expect(RunnerService.initializeRunner).not.toHaveBeenCalled();
  });
  test('rejects unfinished stages and cross-run participant access', async () => {
    const previous = { user: 'student', replication: 'replication', stageId: 'intro' };
    await expect(StageExecutionService.start(replication, 'student', false, previous)).rejects.toThrow(/completed/);
    await expect(
      StageExecutionService.start(replication, 'other', false, { ...previous, finishedAt: new Date() })
    ).rejects.toThrow(/completed/);
    expect(SessionService.create).not.toHaveBeenCalled();
  });
  test('reuses an existing successor on retry and recovers a unique-index race', async () => {
    const previous = {
      id: 'previous',
      user: 'student',
      replication: 'replication',
      stageId: 'intro',
      stageSnapshot: staticStage,
      finishedAt: new Date(),
    };
    const existing = { id: 'existing', isRunnerInitialized: true };
    SessionService.findByPreviousSession.mockResolvedValue(existing);
    expect(await StageExecutionService.start(replication, 'student', false, previous)).toBe('existing');
    expect(SessionService.create).not.toHaveBeenCalled();
    SessionService.findByPreviousSession.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    SessionService.create.mockRejectedValueOnce({ code: 11000 });
    expect(await StageExecutionService.start(replication, 'student', false, previous)).toBe('existing');
  });
});
