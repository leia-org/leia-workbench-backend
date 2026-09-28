import { beforeEach, describe, expect, test, vi } from 'vitest';
import { buildReflectiveContext, getReflectiveSuccessor, validateReflectiveChain } from '../src/utils/reflective.js';
import { initializeExperiment } from '../src/utils/entity.js';

vi.mock('../src/services/v1/ReplicationService.js', () => ({ default: { findById: vi.fn(), findByCode: vi.fn(), findLeia: vi.fn() } }));
vi.mock('../src/services/v1/SessionService.js', () => ({ default: {
  findById: vi.fn(), findByPreviousSession: vi.fn(), create: vi.fn(), updateIsRunnerInitialized: vi.fn(),
  findOneUnfinishedByUserAndReplication: vi.fn(), findByUserAndReplication: vi.fn(),
  saveResultAndFinish: vi.fn(), saveDraft: vi.fn(),
} }));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: { findBySession: vi.fn(), create: vi.fn() } }));
vi.mock('../src/services/v1/RunnerService.js', () => ({ default: { initializeRunner: vi.fn(), sendMessage: vi.fn() } }));
vi.mock('../src/services/v1/UserService.js', () => ({ default: { findByEmail: vi.fn() } }));
vi.mock('../src/services/v1/SpectatorService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/SupervisorService.js', () => ({ default: { observeAsync: vi.fn() } }));
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
  previous = { id: 'previous', leia: 'normal', replication: 'replication', user: 'student', finishedAt: new Date(), result: '', startedAt: new Date() };
  replication = { id: 'replication', isActive: true, language: 'es', experiment: { leias: [
    { id: 'normal', configuration: {}, leia: { spec: { behaviour: { spec: {} } } } },
    { id: 'next', configuration: {}, leia: { spec: { behaviour: { spec: {
      description: '{{reflectiveContext.previousConversation}}', conversationDynamics: {
        stoppingCondition: { enabled: true, prompt: 'Stop after two answers' },
        speaksFirst: { enabled: true, prompt: 'Ask about their approach' },
      },
    } } } } },
  ] } };
  SessionService.findById.mockResolvedValue(previous);
  ReplicationService.findById.mockResolvedValue(replication);
  ReplicationService.findByCode.mockResolvedValue(replication);
  MessageService.findBySession.mockResolvedValue([{ isLeia: false, text: 'Student question' }]);
  SessionService.create.mockImplementation(async (_user, _rep, _leia, _test, options) => ({ id: 'continuation', ...options }));
  UserService.findByEmail.mockResolvedValue({ id: 'student' });
});

describe('Previous conversation context', () => {
  test('enriches in order and can use a conversation without a submitted solution', async () => {
    expect(await buildReflectiveContext({ session: previous, messages: [{ isLeia: false, text: 'Hello' }] }))
      .toEqual({ previousSolution: '', previousConversation: [{ role: 'user', content: 'Hello' }] });
    const experiment = initializeExperiment(replication.experiment);
    expect(experiment.leias[1].configuration).toMatchObject({ askSolution: true, evaluateSolution: true });
    expect(getReflectiveSuccessor(replication, previous).id).toBe('next');
    replication.experiment.leias.push({ id: 'third', leia: { spec: { behaviour: { spec: { description: '{{reflectiveContext.previousSolution}}' } } } } });
    expect(getReflectiveSuccessor(replication, { leia: 'next', previousSession: 'previous' }).id).toBe('third');
    expect(() => validateReflectiveChain({ leias: [experiment.leias[1]] })).toThrow(/follow another/);
  });

  test('creates a contextual continuation without a submitted solution', async () => {
    expect(await InteractionService.startReflectiveSession('previous')).toBe('continuation');
    const snapshot = SessionService.create.mock.calls[0][4].leiaSnapshot;
    expect(snapshot.spec.reflectiveContext.previousConversation).toEqual([{ role: 'user', content: 'Student question' }]);
    expect(snapshot.spec.reflectiveContext.previousSolution).toBe('');
    expect(RunnerService.initializeRunner).toHaveBeenCalledWith('continuation', expect.objectContaining({ leia: snapshot }), 'es');
  });

  test('does not duplicate an existing continuation', async () => {
    SessionService.findByPreviousSession.mockResolvedValue({ id: 'existing', isRunnerInitialized: true });
    expect(await InteractionService.startReflectiveSession('previous')).toBe('existing');
    expect(SessionService.create).not.toHaveBeenCalled();
  });

  test('keeps nested dynamics prompts out of the student payload', async () => {
    previous.finishedAt = null;
    previous.leia = { equals: (id) => id === 'next' };
    replication.experiment.leias[1].leia.spec.problem = { spec: { solution: 'reference' } };
    const result = await InteractionService.getSessionData('previous');
    const dynamics = result.leia.leia.spec.behaviour.spec.conversationDynamics;
    expect(dynamics.stoppingCondition.prompt).toBeUndefined();
    expect(dynamics.speaksFirst.prompt).toBeUndefined();
    expect(dynamics.stoppingCondition.enabled).toBe(true);
  });

  test('rejects unfinished previous sessions and wrong owners', async () => {
    previous.finishedAt = null;
    await expect(InteractionService.startReflectiveSession('previous')).rejects.toThrow(/Finish/);
    previous.finishedAt = new Date();
    previous.user = 'someone-else';
    await expect(InteractionService.startSession('student@example.com', 'code', 'previous')).rejects.toMatchObject({ statusCode: 403 });
  });

  test('generates the optional first LEIA message only once', async () => {
    previous.finishedAt = null;
    previous.leia = 'next';
    ReplicationService.findLeia.mockResolvedValue(replication.experiment.leias[1]);
    MessageService.findBySession.mockResolvedValue([]);
    RunnerService.sendMessage.mockResolvedValue({ message: 'Tell me about your approach.' });
    MessageService.create.mockResolvedValue({ id: 'message', text: 'Tell me about your approach.', isLeia: true });
    SessionService.addMessage = vi.fn().mockResolvedValue(previous);
    expect((await InteractionService.startConversation('previous')).text).toBe('Tell me about your approach.');
    expect(RunnerService.sendMessage).toHaveBeenCalledOnce();
    MessageService.findBySession.mockResolvedValue([{ id: 'message', isLeia: true }]);
    await InteractionService.startConversation('previous');
    expect(RunnerService.sendMessage).toHaveBeenCalledOnce();
  });

  test('waits for a required data-use decision before generating the first message', async () => {
    previous.finishedAt = null;
    previous.dataUsage = { config: { dataUsageConsentRequired: true }, consentStatus: 'pending' };
    expect(await InteractionService.startConversation('previous')).toBeNull();
    expect(RunnerService.sendMessage).not.toHaveBeenCalled();
  });
});
