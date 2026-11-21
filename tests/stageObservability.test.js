import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({
  default: { findById: vi.fn() },
}));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({
  default: {
    findById: vi.fn(),
    findByReplicationAndPopulateMessages: vi.fn(),
  },
}));
vi.mock('../src/services/v1/InteractionService.js', () => ({
  default: { getSessionData: vi.fn() },
}));

import ReplicationRepository from '../src/repositories/v1/ReplicationRepository.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import InteractionService from '../src/services/v1/InteractionService.js';
import ReplicationService from '../src/services/v1/ReplicationService.js';
import SpectatorService from '../src/services/v1/SpectatorService.js';
import {
  getSessionForSpectator,
  getLiveSessionsByReplication,
} from '../src/controllers/v1/spectatorController.js';

describe('Stage observability (conversations, CSV, spectator & live)', () => {
  const replication = {
    id: 'rep-1',
    experiment: {
      stages: [
        { id: 's1', orchestration: { mode: 'single' } },
        { id: 's2', orchestration: { mode: 'single' } },
      ],
      leias: [
        { id: 'l1', stageId: 's1', leia: { id: 'doc1', metadata: { name: 'Interviewer' } } },
        { id: 'l2', stageId: 's2', leia: { id: 'doc2', metadata: { name: 'Reviewer, Sr.' } } },
      ],
    },
  };

  const stage2Session = {
    id: 'sess-2',
    run: 'run-1',
    stageId: 's2',
    stageIndex: 1,
    leia: 'l2',
    user: { email: 'alice@example.com' },
    startedAt: new Date('2026-11-20T10:10:00Z'),
    finishedAt: null,
    result: null,
    evaluation: null,
    score: null,
    messages: [
      { text: 'Second stage question', isLeia: false, timestamp: new Date('2026-11-20T10:11:00Z') },
    ],
  };

  const stage1Session = {
    id: 'sess-1',
    run: 'run-1',
    stageId: 's1',
    stageIndex: 0,
    leia: 'l1',
    user: { email: 'alice@example.com' },
    startedAt: new Date('2026-11-20T10:00:00Z'),
    finishedAt: new Date('2026-11-20T10:05:00Z'),
    result: 'classDiagram\n  class A',
    evaluation: 'Good "work"',
    score: 8.5,
    messages: [
      { text: 'Hello, LEIA', isLeia: false, timestamp: new Date('2026-11-20T10:01:00Z') },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('JWT_SECRET', 'test-spectator-secret');
    ReplicationRepository.findById.mockResolvedValue(replication);
    // Intentionally return stage 2 before stage 1 to verify sorting in CSV.
    SessionRepository.findByReplicationAndPopulateMessages.mockResolvedValue([
      stage2Session,
      stage1Session,
    ]);
  });

  test('getConversations enriches staged sessions with runId, stageNumber, and stageTotal', async () => {
    const result = await ReplicationService.getConversations('rep-1');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'sess-2', runId: 'run-1', stageNumber: 2, stageTotal: 2 });
    expect(result[1]).toMatchObject({ id: 'sess-1', runId: 'run-1', stageNumber: 1, stageTotal: 2 });
  });

  test('getConversationsCSV groups concurrent runs contiguously, sorts by stage, and includes Sender', async () => {
    const concurrentRunStage1 = {
      id: 'sess-b1',
      run: 'run-2',
      stageId: 's1',
      stageIndex: 0,
      leia: 'l1',
      user: { email: 'bob@example.com' },
      startedAt: new Date('2026-11-20T10:05:00Z'),
      finishedAt: null,
      result: null,
      evaluation: null,
      score: null,
      messages: [
        { text: 'Multi agent reply', isLeia: true, senderName: 'Analyst', timestamp: new Date('2026-11-20T10:06:00Z') },
      ],
    };
    SessionRepository.findByReplicationAndPopulateMessages.mockResolvedValue([
      stage2Session,
      concurrentRunStage1,
      stage1Session,
    ]);

    const csv = await ReplicationService.getConversationsCSV('rep-1');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      'Session ID,Run ID,Stage,LEIA,User,Started At,Finished At,Message,Is LEIA,Sender,Timestamp,Score,Evaluation,Submitted Solution'
    );
    // run-1 (started 10:00) keeps Stage 1 and Stage 2 contiguous before run-2 (started 10:05).
    const stage1Pos = csv.indexOf('sess-1,run-1,1/2,Interviewer');
    const stage2Pos = csv.indexOf('sess-2,run-1,2/2,"Reviewer, Sr."');
    const run2Pos = csv.indexOf('sess-b1,run-2,1/2,Interviewer');
    expect(stage1Pos).toBeGreaterThan(0);
    expect(stage2Pos).toBeGreaterThan(stage1Pos);
    expect(run2Pos).toBeGreaterThan(stage2Pos);
    expect(csv).toContain(',FALSE,Participant,');
    expect(csv).toContain(',TRUE,Analyst,');
    expect(csv).toContain('"classDiagram\n  class A"');
    expect(csv).toContain('"Good ""work"""');
  });

  test('spectate token carries runId and authorizes later stages within the same ActivityRun only', async () => {
    SessionRepository.findById.mockImplementation(async (id) => {
      if (id === 'sess-1') return { id: 'sess-1', run: 'run-1', replication: 'rep-1' };
      if (id === 'sess-2') return { id: 'sess-2', run: 'run-1', replication: 'rep-1' };
      if (id === 'sess-other') return { id: 'sess-other', run: 'run-2', replication: 'rep-1' };
      return null;
    });

    const { token } = await SpectatorService.generateSpectateToken('sess-1', 3600);
    const decoded = SpectatorService.verifySpectateToken(token);
    expect(decoded.runId).toBe('run-1');

    InteractionService.getSessionData.mockResolvedValue({ session: { id: 'sess-2' } });
    const resOk = { json: vi.fn() };
    const nextOk = vi.fn();
    await getSessionForSpectator(
      { params: { id: 'sess-2' }, spectateSession: 'sess-1', spectateRun: 'run-1' },
      resOk,
      nextOk
    );
    expect(nextOk).not.toHaveBeenCalled();
    expect(resOk.json).toHaveBeenCalledWith({ session: { id: 'sess-2' } });

    const nextDenied = vi.fn();
    await getSessionForSpectator(
      { params: { id: 'sess-other' }, spectateSession: 'sess-1', spectateRun: 'run-1' },
      { json: vi.fn() },
      nextDenied
    );
    expect(nextDenied).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  test('getLiveSessionsByReplication exposes runId, stageNumber, and stageTotal', async () => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    const next = vi.fn();
    await getLiveSessionsByReplication(
      { params: { id: 'rep-1' }, query: {}, user: { isAdmin: true } },
      res,
      next
    );
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 2,
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: 'sess-1', runId: 'run-1', stageNumber: 1, stageTotal: 2 }),
          expect.objectContaining({ id: 'sess-2', runId: 'run-1', stageNumber: 2, stageTotal: 2, isActive: true }),
        ]),
      })
    );
  });
});
