import { beforeEach, describe, expect, test, vi } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('../src/repositories/v1/SessionRepository.js', () => ({ default: { findById: vi.fn() } }));
vi.mock('../src/services/v1/ReplicationService.js', () => ({ default: { findLeia: vi.fn() } }));
vi.mock('../src/services/v1/SessionService.js', () => ({ default: { markConversationEnded: vi.fn() } }));

import LukeService from '../src/services/v1/LukeService.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import ReplicationService from '../src/services/v1/ReplicationService.js';
import SessionService from '../src/services/v1/SessionService.js';
import { finishLukeConversation } from '../src/controllers/v1/realtimeController.js';

const session = { id: 'session-1', leia: 'leia-1', replication: 'replication-1', finishedAt: null };
const leia = { runnerConfiguration: { audioMode: 'luke' }, leia: { spec: { behaviour: { spec: {
  conversationDynamics: { stoppingCondition: { enabled: true, prompt: 'Stop when done' } },
} } } } };

beforeEach(() => {
  vi.resetAllMocks();
  SessionRepository.findById.mockResolvedValue({ ...session });
  ReplicationService.findLeia.mockResolvedValue(leia);
});

describe('Luke finish_conversation', () => {
  test('persists completion for the matching Luke session and is idempotent', async () => {
    await expect(LukeService.finishConversation('session-1', 'session-1', 'leia-1'))
      .resolves.toEqual({ conversationEnded: true });
    expect(SessionService.markConversationEnded).toHaveBeenCalledWith('session-1');
    SessionRepository.findById.mockResolvedValue({ ...session, conversationEnded: true });
    await LukeService.finishConversation('session-1', 'session-1', 'leia-1');
    expect(SessionService.markConversationEnded).toHaveBeenCalledTimes(1);
  });

  test('rejects a different session and a LEIA without Luke stopping condition', async () => {
    await expect(LukeService.finishConversation('session-1', 'other', 'leia-1'))
      .rejects.toMatchObject({ statusCode: 403 });
    ReplicationService.findLeia.mockResolvedValue({ ...leia, runnerConfiguration: { audioMode: 'realtime' } });
    await expect(LukeService.finishConversation('session-1', 'session-1', 'leia-1'))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(SessionService.markConversationEnded).not.toHaveBeenCalled();
  });

  test('HTTP handler requires a Luke token and forwards the completion result', async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    await finishLukeConversation({ params: { sessionId: 'session-1' }, headers: {} }, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    next.mockClear();
    await finishLukeConversation({
      params: { sessionId: 'session-1' },
      headers: { 'x-luke-token': jwt.sign({ sessionId: 'session-1', leiaId: 'leia-1' }, process.env.JWT_SECRET || 'secret') },
    }, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ conversationEnded: true });
    expect(next).not.toHaveBeenCalled();
  });
});
