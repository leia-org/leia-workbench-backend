import { beforeEach, describe, expect, test, vi } from 'vitest';
import { buildReflectiveContext, getReflectiveSuccessor, validateReflectiveChain } from '../src/utils/reflective.js';
import { initializeExperiment } from '../src/utils/entity.js';

vi.mock('../src/services/v1/ReplicationService.js', () => ({ default: { findById: vi.fn(), findByCode: vi.fn(), findLeia: vi.fn() } }));
vi.mock('../src/services/v1/SessionService.js', () => ({ default: {
  findById: vi.fn(), findByPreviousSession: vi.fn(), create: vi.fn(), updateIsRunnerInitialized: vi.fn(),
  findOneUnfinishedByUserAndReplication: vi.fn(), findByUserAndReplication: vi.fn(),
  saveResultAndFinish: vi.fn(), saveDraft: vi.fn(),
} }));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: { findBySession: vi.fn() } }));
vi.mock('../src/services/v1/RunnerService.js', () => ({ default: { initializeRunner: vi.fn() } }));
vi.mock('../src/services/v1/UserService.js', () => ({ default: { findByEmail: vi.fn() } }));
vi.mock('../src/services/v1/SpectatorService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/SupervisorService.js', () => ({ default: {} }));
vi.mock('../src/utils/logger.js', () => ({ default: { info: vi.fn() } }));

import InteractionService from '../src/services/v1/InteractionService.js';
import ReplicationService from '../src/services/v1/ReplicationService.js';
import SessionService from '../src/services/v1/SessionService.js';
import MessageService from '../src/services/v1/MessageService.js';
import RunnerService from '../src/services/v1/RunnerService.js';
import UserService from '../src/services/v1/UserService.js';

let replication, previous;
beforeEach(() => {
  vi.resetAllMocks();
  previous = { id: 'previous', leia: 'normal', replication: 'replication', user: 'student', finishedAt: new Date(), result: 'Submitted answer', startedAt: new Date() };
  replication = { id: 'replication', isActive: true, reflectiveEnabled: true, language: 'es', experiment: { leias: [
    { id: 'normal', configuration: {}, leia: { spec: { behaviour: { spec: {} } } } },
    { id: 'reflective', configuration: {}, leia: { spec: { behaviour: { spec: {
      reflective: true, evaluationPrompt: 'Explain decisions', stoppingPrompt: 'Stop after two answers', description: '{{reflectiveContext.previousSolution}}',
    } } } } },
  ] } };
  SessionService.findById.mockResolvedValue(previous);
  ReplicationService.findById.mockResolvedValue(replication);
  ReplicationService.findByCode.mockResolvedValue(replication);
  MessageService.findBySession.mockResolvedValue([{ isLeia: false, text: 'Student question' }, { isLeia: true, text: 'LEIA reply' }]);
  SessionService.create.mockImplementation(async (_user, _rep, _leia, _test, options) => ({ id: 'next', ...options }));
  UserService.findByEmail.mockResolvedValue({ id: 'student' });
});

describe('Reflective context pipeline and deployment', () => {
  test('runs enrichment filters in order, includes submitted result rather than draft', async () => {
    const source = { session: { result: 'Final', draft: 'Draft' }, messages: [{ isLeia: false, text: 'Hello' }] };
    expect(await buildReflectiveContext(source)).toEqual({ previousSolution: 'Final', previousConversation: [{ role: 'user', content: 'Hello' }] });
    expect(await buildReflectiveContext(source, [(c) => ({ ...c, first: 1 }), async (c) => ({ ...c, second: c.first + 1 })])).toEqual({ first: 1, second: 2 });
  });
  test('initializes reflections without solution or evaluation and respects the switch', () => {
    const experiment = initializeExperiment(replication.experiment);
    expect(experiment.leias[1].configuration).toMatchObject({ askSolution: false, evaluateSolution: false });
    expect(experiment.leias[0].configuration.askSolution).toBe(true);
    expect(getReflectiveSuccessor(replication, previous).id).toBe('reflective');
    expect(getReflectiveSuccessor({ ...replication, reflectiveEnabled: false }, previous)).toBeNull();
    expect(() => validateReflectiveChain({ leias: [experiment.leias[1]] })).toThrow();
  });
});

describe('LN → LR continuation', () => {
  test('captures the correct previous session and starts a fresh interview without mutating the activity', async () => {
    expect(await InteractionService.startReflectiveSession('previous')).toBe('next');
    const options = SessionService.create.mock.calls[0][4];
    expect(options.previousSession).toBe('previous');
    expect(options.leiaSnapshot.spec.reflectiveContext).toEqual({ previousSolution: 'Submitted answer', previousConversation: [
      { role: 'user', content: 'Student question' }, { role: 'assistant', content: 'LEIA reply' },
    ] });
    expect(replication.experiment.leias[1].leia.spec.reflectiveContext).toBeUndefined();
    expect(RunnerService.initializeRunner).toHaveBeenCalledWith('next', expect.objectContaining({ leia: options.leiaSnapshot }), 'es');
  });
  test('resumes an existing continuation without creating it again or rebuilding context', async () => {
    SessionService.findByPreviousSession.mockResolvedValue({ id: 'existing', isRunnerInitialized: true });
    expect(await InteractionService.startReflectiveSession('previous')).toBe('existing');
    expect(SessionService.create).not.toHaveBeenCalled();
    expect(MessageService.findBySession).not.toHaveBeenCalled();
  });
  test('recovers the winning session when concurrent requests hit the unique index', async () => {
    SessionService.findByPreviousSession.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'winner', isRunnerInitialized: true });
    SessionService.create.mockRejectedValue({ code: 11000 });
    expect(await InteractionService.startReflectiveSession('previous')).toBe('winner');
    expect(RunnerService.initializeRunner).not.toHaveBeenCalled();
  });
  test('student payload excludes the immutable snapshot and instructor prompts', async () => {
    previous.previousSession = 'source';
    previous.leiaSnapshot = { secret: 'private context' };
    previous.leia = { equals: (id) => id === 'reflective', toString: () => 'reflective' };
    const entry = replication.experiment.leias[1];
    entry.leia.spec.problem = { spec: { solution: 'reference solution' } };
    entry.configuration = { askSolution: true, evaluateSolution: true };
    const result = await InteractionService.getSessionData('next');
    expect(result.session.leiaSnapshot).toBeUndefined();
    expect(result.leia.leia.spec.behaviour.spec.evaluationPrompt).toBeUndefined();
    expect(result.leia.leia.spec.behaviour.spec.stoppingPrompt).toBeUndefined();
    expect(result.leia.configuration).toMatchObject({ askSolution: false, evaluateSolution: false });
    expect(result.reflectiveAvailable).toBe(false);
  });
  test('recovers after the runner was created but the initialized flag was not saved', async () => {
    SessionService.findByPreviousSession.mockResolvedValue({ id: 'existing', leiaSnapshot: { spec: {} } });
    RunnerService.initializeRunner.mockRejectedValue({ response: { status: 409 } });
    expect(await InteractionService.startReflectiveSession('previous')).toBe('existing');
    expect(SessionService.updateIsRunnerInitialized).toHaveBeenCalledWith('existing', true);
  });
  test('rejects unfinished sessions, missing submissions, disabled reflection, and wrong owners', async () => {
    previous.finishedAt = null;
    await expect(InteractionService.startReflectiveSession('previous')).rejects.toThrow(/submit/);
    previous.finishedAt = new Date();
    previous.result = '';
    await expect(InteractionService.startReflectiveSession('previous')).rejects.toThrow(/submit/);
    previous.result = 'answer';
    replication.reflectiveEnabled = false;
    await expect(InteractionService.startReflectiveSession('previous')).rejects.toThrow(/enabled/);
    replication.reflectiveEnabled = true;
    previous.user = 'someone-else';
    await expect(InteractionService.startSession('student@example.com', 'code', 'previous')).rejects.toMatchObject({ statusCode: 403 });
    expect(SessionService.create).not.toHaveBeenCalled();
  });
  test('offers the pending reflection on login even in a non-repeatable replication', async () => {
    replication.isRepeatable = false;
    SessionService.findByUserAndReplication.mockResolvedValue([previous]);
    expect(await InteractionService.startSession('student@example.com', 'code')).toBe('next');
  });
  test('rejects solution submissions and drafts in a reflective session', async () => {
    SessionService.findById.mockResolvedValue({ id: 'next', previousSession: 'previous' });
    await expect(InteractionService.saveResultAndFinishSession('next', 'new solution')).rejects.toThrow(/does not accept/);
    await expect(InteractionService.saveDraft('next', 'new draft')).rejects.toThrow(/does not accept/);
    expect(SessionService.saveResultAndFinish).not.toHaveBeenCalled();
    expect(SessionService.saveDraft).not.toHaveBeenCalled();
  });
});
