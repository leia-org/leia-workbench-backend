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
