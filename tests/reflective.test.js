import { beforeEach, describe, expect, test, vi } from 'vitest';
import { buildReflectiveContext, getReflectiveSuccessor, validateReflectiveChain } from '../src/utils/reflective.js';
import { initializeExperiment } from '../src/utils/entity.js';

test('static stages expose only participant content and complete without a runner', async () => {
  const stage = { id: 'intro', type: 'StaticContentStage', version: 1, title: 'Read', config: { content: '# Welcome' } };
  const session = { id: 'static', replication: 'replication', stageId: 'intro', stageSnapshot: stage,
    interactionMode: 'static', stageEntries: [{ secret: true }], previousStage: { private: true }, user: 'student' };
  const experiment = { stages: [stage, { ...stage, id: 'next' }], leias: [] };
  SessionService.findById.mockResolvedValue(session);
  SessionService.finish.mockResolvedValue({ ...session, finishedAt: new Date() });
  ReplicationService.findById.mockResolvedValue({ id: 'replication', experiment, toJSON: () => ({ id: 'replication', experiment }) });
  const data = await InteractionService.getSessionData('static');
  expect(data.stage).toEqual({ id: 'intro', type: 'StaticContentStage', title: 'Read', content: '# Welcome' });
  expect(data.replication.experiment).toBeUndefined();
  expect(data.session.stageEntries).toBeUndefined();
  expect(data.session.previousStage).toBeUndefined();
  const finished = await InteractionService.finishSession('static');
  expect(finished.reflectiveAvailable).toBe(true);
  expect(RunnerService.deleteCache).not.toHaveBeenCalled();
});

vi.mock('../src/services/v1/ReplicationService.js', () => ({ default: { findById: vi.fn(), findByCode: vi.fn(), findLeia: vi.fn() } }));
vi.mock('../src/services/v1/SessionService.js', () => ({ default: {
  findById: vi.fn(), findByPreviousSession: vi.fn(), create: vi.fn(), updateIsRunnerInitialized: vi.fn(),
  findOneUnfinishedByUserAndReplication: vi.fn(), findByUserAndReplication: vi.fn(),
  saveResultAndFinish: vi.fn(), saveDraft: vi.fn(),
  finish: vi.fn(), markConversationEnded: vi.fn(),
} }));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: { findBySession: vi.fn(), create: vi.fn() } }));
vi.mock('../src/services/v1/RunnerService.js', () => ({ default: { initializeRunner: vi.fn(), sendMessage: vi.fn(), deleteCache: vi.fn() } }));
vi.mock('../src/services/v1/UserService.js', () => ({ default: { findByEmail: vi.fn() } }));
vi.mock('../src/services/v1/SpectatorService.js', () => ({ default: { generateSpectateToken: vi.fn().mockResolvedValue({ token: 'token', expiresAt: new Date() }), generateSpectateUrl: vi.fn().mockReturnValue('https://example.test/spectate') } }));
vi.mock('../src/services/v1/SupervisorService.js', () => ({ default: { observeAsync: vi.fn() } }));
vi.mock('../src/utils/logger.js', () => ({ default: { info: vi.fn() } }));

import InteractionService from '../src/services/v1/InteractionService.js';
import { sendSessionMessage as sendSessionMessageController } from '../src/controllers/v1/interactionController.js';
import ReplicationService from '../src/services/v1/ReplicationService.js';
import SessionService from '../src/services/v1/SessionService.js';
import MessageService from '../src/services/v1/MessageService.js';
import RunnerService from '../src/services/v1/RunnerService.js';
import SpectatorService from '../src/services/v1/SpectatorService.js';
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

  test('blocks both finish routes until LEIA signals the end of a stopping-condition conversation', async () => {
    previous.finishedAt = null;
    ReplicationService.findLeia.mockResolvedValue(replication.experiment.leias[1]);
    await expect(InteractionService.finishSession('previous')).rejects.toMatchObject({ statusCode: 409 });
    await expect(InteractionService.saveResultAndFinishSession('previous', 'answer')).rejects.toMatchObject({ statusCode: 409 });
    expect(SessionService.finish).not.toHaveBeenCalled();
    expect(SessionService.saveResultAndFinish).not.toHaveBeenCalled();

    previous.conversationEnded = true;
    SessionService.finish.mockResolvedValue({ ...previous, finishedAt: new Date() });
    SpectatorService.generateSpectateToken.mockResolvedValue({ token: 'token', expiresAt: new Date() });
    SpectatorService.generateSpectateUrl.mockReturnValue('https://example.test/spectate');
    await InteractionService.finishSession('previous');
    expect(SessionService.finish).toHaveBeenCalledWith('previous');
  });

  test('requires Luke completion while leaving Realtime sessions unchanged', async () => {
    previous.finishedAt = null;
    const leia = replication.experiment.leias[1];
    leia.runnerConfiguration = { audioMode: 'luke' };
    ReplicationService.findLeia.mockResolvedValue(leia);
    await expect(InteractionService.finishSession('previous')).rejects.toMatchObject({ statusCode: 409 });
    leia.runnerConfiguration.audioMode = 'realtime';
    SessionService.finish.mockResolvedValue({ ...previous, finishedAt: new Date() });
    SpectatorService.generateSpectateToken.mockResolvedValue({ token: 'token', expiresAt: new Date() });
    SpectatorService.generateSpectateUrl.mockReturnValue('https://example.test/spectate');
    await InteractionService.finishSession('previous');
    expect(SessionService.finish).toHaveBeenCalledWith('previous');
  });

  test('persists the completion signal returned by Runner and exposes it to the chat', async () => {
    previous.finishedAt = null;
    ReplicationService.findLeia.mockResolvedValue(replication.experiment.leias[1]);
    RunnerService.sendMessage.mockResolvedValue({ message: 'Goodbye.', conversationEnded: true });
    SessionService.markConversationEnded.mockResolvedValue({ ...previous, conversationEnded: true });
    MessageService.create.mockResolvedValue({ id: 'last-message' });
    SessionService.addMessage = vi.fn().mockResolvedValue({ ...previous, conversationEnded: true });

    expect(await InteractionService.sendSessionMessage('previous', 'Thank you')).toMatchObject({
      message: 'Goodbye.', conversationEnded: true,
    });
    expect(SessionService.markConversationEnded).toHaveBeenCalledWith('previous');
  });

  test('forwards completion through the HTTP response used by the chat', async () => {
    const send = vi.spyOn(InteractionService, 'sendSessionMessage').mockResolvedValue({
      message: 'Goodbye.', conversationEnded: true,
    });
    const res = { json: vi.fn() };
    const next = vi.fn();
    await sendSessionMessageController({ params: { sessionId: 'previous' }, body: { message: 'Thanks' } }, res, next);
    expect(send).toHaveBeenCalledWith('previous', 'Thanks', expect.any(Object));
    expect(res.json).toHaveBeenCalledWith({ message: 'Goodbye.', conversationEnded: true });
    expect(next).not.toHaveBeenCalled();
    send.mockResolvedValue({ toolCalls: [{ callId: 'widget-call', name: 'read_editor', arguments: '{}' }], conversationEnded: true });
    await sendSessionMessageController({ params: { sessionId: 'previous' }, body: { message: 'One more thing' } }, res, next);
    expect(res.json).toHaveBeenLastCalledWith({
      toolCalls: [{ callId: 'widget-call', name: 'read_editor', arguments: '{}' }], conversationEnded: true,
    });
    send.mockRestore();
  });
});
