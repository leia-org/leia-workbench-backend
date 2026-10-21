import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../src/models/Session.js', () => ({ default: { findOneAndUpdate: vi.fn(), updateOne: vi.fn() } }));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: { findBySession: vi.fn(), create: vi.fn() } }));
vi.mock('../src/services/v1/SessionService.js', () => ({ default: { findById: vi.fn(), addMessage: vi.fn() } }));
vi.mock('../src/services/v1/ReplicationService.js', () => ({ default: { findLeia: vi.fn() } }));
vi.mock('../src/services/v1/RunnerService.js', () => ({ default: { sendMessage: vi.fn(), evaluateStoppingCondition: vi.fn() } }));
vi.mock('../src/utils/logger.js', () => ({ default: { error: vi.fn() } }));
import Session from '../src/models/Session.js';
import MessageService from '../src/services/v1/MessageService.js';
import SessionService from '../src/services/v1/SessionService.js';
import RunnerService from '../src/services/v1/RunnerService.js';
import Dynamics, { publicDynamicsState } from '../src/services/v1/ConversationDynamicsService.js';
const leia = (dynamics = {}, audioMode) => ({ leia: { spec: { behaviour: { spec: { conversationDynamics: dynamics } } } }, runnerConfiguration: { audioMode } });
const both = leia({ leiaSpeaksFirst: { enabled: true, config: { firstMessage: 'Introduce yourself' } },
  stoppingCondition: { enabled: true, config: { condition: 'The student refuses to cooperate' } } });

beforeEach(() => { vi.clearAllMocks(); MessageService.findBySession.mockResolvedValue([]); Session.updateOne.mockResolvedValue({}); });
describe('shared chat / Luke dynamics lifecycle', () => {
  test('legacy and disabled dynamics allow manual finish', async () => {
    expect(publicDynamicsState({}, leia()).canFinish).toBe(true);
    await expect(Dynamics.assertCanFinish({}, leia({ stoppingCondition: { enabled: false } }))).resolves.toBeUndefined();
  });
  test('active stopping blocks completion until the server decision is satisfied', async () => {
    await expect(Dynamics.assertCanFinish({}, both)).rejects.toMatchObject({ statusCode: 403 });
    await expect(Dynamics.assertCanFinish({ conversationDynamicsState: { stoppingCondition: { satisfied: true } } }, both)).resolves.toBeUndefined();
    await expect(Dynamics.assertCanFinish({}, null)).rejects.toMatchObject({ statusCode: 404 });
  });
  test('text opening persists an assistant message and no student message', async () => {
    Session.findOneAndUpdate.mockResolvedValue({});
    RunnerService.sendMessage.mockResolvedValue({ message: 'Hello!' });
    MessageService.create.mockResolvedValue({ id: 'opening' });
    await Dynamics.openText('session', both);
    expect(MessageService.create).toHaveBeenCalledWith('Hello!', true, 'session');
    expect(SessionService.addMessage).toHaveBeenCalledWith('session', 'opening');
    expect(Session.updateOne).toHaveBeenCalledWith({ _id: 'session' }, { $set: { 'conversationDynamicsState.leiaSpeaksFirst.completed': true } });
  });
  test('opening is skipped on reload and a lost concurrent claim', async () => {
    MessageService.findBySession.mockResolvedValue([{ isLeia: true }]);
    await Dynamics.openText('session', both);
    expect(RunnerService.sendMessage).not.toHaveBeenCalled();
    MessageService.findBySession.mockResolvedValue([]);
    Session.findOneAndUpdate.mockResolvedValue(null);
    await Dynamics.openText('session', both);
    expect(RunnerService.sendMessage).not.toHaveBeenCalled();
  });
  test('failed opening releases its claim for retry', async () => {
    Session.findOneAndUpdate.mockResolvedValue({});
    RunnerService.sendMessage.mockRejectedValue(new Error('provider failed'));
    await expect(Dynamics.openText('session', both)).rejects.toThrow('provider failed');
    expect(Session.updateOne).toHaveBeenCalledWith({ _id: 'session' }, { $unset: { 'conversationDynamicsState.leiaSpeaksFirst.claimedAt': 1 } });
  });
  test('Luke sends its opening once and waits for assistant transcription before completion', async () => {
    Session.findOneAndUpdate.mockResolvedValue({});
    const send = vi.fn();
    await Dynamics.open('session', both, send, true);
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Introduce yourself'));
    expect(Session.updateOne).not.toHaveBeenCalled();
    await Dynamics.completeOpening('session');
    expect(Session.updateOne).toHaveBeenCalled();
    await Dynamics.openText('session', leia(both.leia.spec.behaviour.spec.conversationDynamics, 'luke'));
    expect(RunnerService.sendMessage).not.toHaveBeenCalled();
  });
  test('evaluates the recorded exchange, persists a monotonic fulfilled decision', async () => {
    SessionService.findById.mockResolvedValue({});
    MessageService.findBySession.mockResolvedValue([{ id: 'user', isLeia: false, text: 'I refuse' }, { id: 'reply', isLeia: true, text: 'Goodbye' }]);
    RunnerService.evaluateStoppingCondition.mockResolvedValue({ satisfied: true });
    await Dynamics.observe('session', both);
    expect(RunnerService.evaluateStoppingCondition).toHaveBeenCalledWith('The student refuses to cooperate', [
      { role: 'student', text: 'I refuse' }, { role: 'leia', text: 'Goodbye' },
    ], undefined, both.runnerConfiguration);
    expect(Session.updateOne).toHaveBeenCalledWith(
      { _id: 'session', 'conversationDynamicsState.stoppingCondition.satisfied': { $ne: true } },
      { $set: { 'conversationDynamicsState.stoppingCondition': { satisfied: true, lastMessageId: 'reply', decidedAt: expect.any(Date) } } });
  });
  test('opening alone does not evaluate the stopping condition', async () => {
    SessionService.findById.mockResolvedValue({});
    MessageService.findBySession.mockResolvedValue([{ id: 'opening', isLeia: true, text: 'Hello' }]);
    await Dynamics.observe('session', both);
    expect(RunnerService.evaluateStoppingCondition).not.toHaveBeenCalled();
  });
  test('evaluation failure preserves the locked state and does not throw away a turn', async () => {
    SessionService.findById.mockResolvedValue({});
    MessageService.findBySession.mockResolvedValue([{ isLeia: false }, { id: 'reply', isLeia: true }]);
    RunnerService.evaluateStoppingCondition.mockRejectedValue(new Error('unavailable'));
    await expect(Dynamics.observeSafely('session', both)).resolves.toBeUndefined();
    expect(Session.updateOne).not.toHaveBeenCalled();
    expect(publicDynamicsState({}, both).canFinish).toBe(false);
  });
});
