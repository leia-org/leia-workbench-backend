import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../src/models/Session.js', () => ({ default: {} }));
vi.mock('../src/services/v1/SessionService.js', () => ({ default: { findById: vi.fn(), finish: vi.fn(), saveResultAndFinish: vi.fn() } }));
vi.mock('../src/services/v1/ReplicationService.js', () => ({ default: { findLeia: vi.fn() } }));
vi.mock('../src/services/v1/RunnerService.js', () => ({ default: { deleteCache: vi.fn() } }));
vi.mock('../src/services/v1/UserService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/SupervisorService.js', () => ({ default: { observeAsync: vi.fn() } }));
vi.mock('../src/services/v1/SpectatorService.js', () => ({ default: { generateSpectateToken: vi.fn(), generateSpectateUrl: vi.fn() } }));
vi.mock('../src/utils/logger.js', () => ({ default: { info: vi.fn(), error: vi.fn() } }));
import InteractionService from '../src/services/v1/InteractionService.js';
import SessionService from '../src/services/v1/SessionService.js';
import ReplicationService from '../src/services/v1/ReplicationService.js';
import SpectatorService from '../src/services/v1/SpectatorService.js';
import { getSolution } from '../src/controllers/v1/interactionController.js';
const session = { id: 'session', replication: 'replication', leia: 'leia' };
beforeEach(() => {
  vi.clearAllMocks();
  SessionService.findById.mockResolvedValue(session);
  ReplicationService.findLeia.mockResolvedValue({ leia: { spec: { behaviour: { spec: {
    conversationDynamics: { stoppingCondition: { enabled: true, config: { condition: 'Task complete' } } },
  } } } } });
  SessionService.finish.mockResolvedValue({ ...session, finishedAt: new Date() });
  SessionService.saveResultAndFinish.mockResolvedValue({ ...session, finishedAt: new Date(), result: 'solution' });
  SpectatorService.generateSpectateToken.mockResolvedValue({ token: 'token', expiresAt: new Date() });
  SpectatorService.generateSpectateUrl.mockReturnValue('spectate');
});
describe('finish and result endpoint enforcement', () => {
  test('returns the reference solution through the HTTP controller after submission', async () => {
    SessionService.findById.mockResolvedValue({ ...session, finishedAt: new Date(), result: 'answer' });
    ReplicationService.findLeia.mockResolvedValue({ leia: { spec: { problem: { spec: {
      solution: 'Reference answer', solutionFormat: 'text',
    } } } } });
    const response = { json: vi.fn() };
    const next = vi.fn();
    await getSolution({ params: { sessionId: 'session' } }, response, next);
    expect(next).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({ solution: 'Reference answer', solutionFormat: 'text' });
  });
  test('retries the same saved result without overwriting or rerunning the supervisor', async () => {
    SessionService.findById.mockResolvedValue({ ...session, finishedAt: new Date(), result: 'solution' });
    const result = await InteractionService.saveResultAndFinishSession('session', 'solution');
    expect(result.result).toBe('solution');
    expect(result.spectateUrl).toBe('spectate');
    expect(SessionService.saveResultAndFinish).not.toHaveBeenCalled();
  });
  test('does not allow changing a result after submission', async () => {
    SessionService.findById.mockResolvedValue({ ...session, finishedAt: new Date(), result: 'original' });
    await expect(InteractionService.saveResultAndFinishSession('session', 'changed')).rejects.toMatchObject({ statusCode: 403 });
    expect(SessionService.saveResultAndFinish).not.toHaveBeenCalled();
  });
  test('returns an existing zero score without evaluating again', async () => {
    SessionService.findById.mockResolvedValue({ ...session, finishedAt: new Date(), result: 'solution', evaluation: 'Try again', score: 0 });
    await expect(InteractionService.getEvaluation('session')).resolves.toEqual({ evaluation: 'Try again', score: 0 });
  });
  for (const method of ['finishSession', 'saveResultAndFinishSession']) {
    test(`${method} rejects a premature finish before any database mutation`, async () => {
      await expect(InteractionService[method]('session', 'solution')).rejects.toMatchObject({ statusCode: 403 });
      expect(SessionService.finish).not.toHaveBeenCalled();
      expect(SessionService.saveResultAndFinish).not.toHaveBeenCalled();
      expect(SpectatorService.generateSpectateToken).not.toHaveBeenCalled();
    });
    test(`${method} accepts LEIA's saved decision and hides internal state`, async () => {
      const decided = { ...session, conversationDynamicsState: { stoppingCondition: { satisfied: true } } };
      SessionService.findById.mockResolvedValue(decided);
      SessionService.finish.mockResolvedValue({ ...decided, finishedAt: new Date() });
      SessionService.saveResultAndFinish.mockResolvedValue({ ...decided, finishedAt: new Date() });
      const result = await InteractionService[method]('session', 'solution');
      expect(result.finishedAt).toBeInstanceOf(Date);
      expect(result.conversationDynamicsState).toBeUndefined();
    });
  }
});
