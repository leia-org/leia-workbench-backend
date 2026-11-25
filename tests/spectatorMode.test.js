import { beforeEach, describe, expect, test, vi } from 'vitest';

const { mockEmitToSession, mockEmitToReplication } = vi.hoisted(() => ({
  mockEmitToSession: vi.fn(),
  mockEmitToReplication: vi.fn(),
}));

vi.mock('../src/socket/index.js', () => ({
  emitToSession: mockEmitToSession,
  emitToReplication: mockEmitToReplication,
}));

vi.mock('../src/repositories/v1/SessionRepository.js', () => ({
  default: {
    findById: vi.fn(),
    findByRun: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({
  default: {
    findById: vi.fn(),
  },
}));

vi.mock('../src/services/v1/InteractionService.js', () => ({
  default: {
    getSessionData: vi.fn(),
  },
}));

import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import ReplicationRepository from '../src/repositories/v1/ReplicationRepository.js';
import InteractionService from '../src/services/v1/InteractionService.js';
import SessionService from '../src/services/v1/SessionService.js';
import SpectatorService from '../src/services/v1/SpectatorService.js';
import { getSessionForSpectator } from '../src/controllers/v1/spectatorController.js';
import { shouldShowEvaluationToParticipant } from '../src/utils/rubricEvaluation.js';

describe('Spectator mode: stage history & per-stage evaluation visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('JWT_SECRET', 'test-spectator-secret');
  });

  test('shouldShowEvaluationToParticipant respects showSolution, askSolution, and evaluationMode', () => {
    expect(
      shouldShowEvaluationToParticipant({
        askSolution: true,
        evaluationMode: 'classic',
        showSolution: true,
      })
    ).toBe(true);
    expect(
      shouldShowEvaluationToParticipant({
        askSolution: true,
        evaluationMode: 'classic',
        showSolution: false,
      })
    ).toBe(false);
    expect(
      shouldShowEvaluationToParticipant({
        askSolution: false,
        evaluationMode: 'rubric',
        showSolution: true,
      })
    ).toBe(true);
    expect(
      shouldShowEvaluationToParticipant({
        askSolution: false,
        evaluationMode: 'rubric',
        showSolution: false,
      })
    ).toBe(false);
    expect(
      shouldShowEvaluationToParticipant({
        askSolution: true,
        evaluationMode: 'rubric',
        showSolution: false,
      })
    ).toBe(false);
    expect(
      shouldShowEvaluationToParticipant({
        askSolution: true,
        evaluationMode: 'none',
        showSolution: true,
      })
    ).toBe(false);
    expect(
      shouldShowEvaluationToParticipant({
        askSolution: false,
        evaluationMode: 'classic',
        showSolution: true,
      })
    ).toBe(false);
  });

  test('SessionService.saveEvaluationAndScore suppresses session room emit when emitToSessionRoom is false while notifying replication dashboard', async () => {
    const saved = {
      id: 'sess-hidden',
      replication: 'rep-1',
      score: 8,
      evaluation: 'Hidden from spectator',
      evaluationMode: 'rubric',
      rubricEvaluation: { totalScore: 8, sections: [] },
    };
    SessionRepository.update.mockResolvedValue(saved);

    await SessionService.saveEvaluationAndScore('sess-hidden', saved.evaluation, saved.score, {
      evaluationMode: 'rubric',
      rubricEvaluation: saved.rubricEvaluation,
      emitToSessionRoom: false,
    });

    expect(mockEmitToSession).not.toHaveBeenCalled();
    expect(mockEmitToReplication).toHaveBeenCalledWith(
      'rep-1',
      'session:evaluated',
      expect.objectContaining({
        sessionId: 'sess-hidden',
        score: 8,
        evaluation: 'Hidden from spectator',
      })
    );
  });

  test('SessionService.saveEvaluationAndScore emits to both session room and replication when emitToSessionRoom is true', async () => {
    const saved = {
      id: 'sess-visible',
      replication: 'rep-1',
      score: 9.5,
      evaluation: 'Visible to spectator',
      evaluationMode: 'classic',
    };
    SessionRepository.update.mockResolvedValue(saved);

    await SessionService.saveEvaluationAndScore('sess-visible', saved.evaluation, saved.score, {
      emitToSessionRoom: true,
    });

    expect(mockEmitToSession).toHaveBeenCalledWith(
      'sess-visible',
      'session:evaluated',
      expect.objectContaining({
        sessionId: 'sess-visible',
        score: 9.5,
        evaluation: 'Visible to spectator',
      })
    );
    expect(mockEmitToReplication).toHaveBeenCalledWith(
      'rep-1',
      'session:evaluated',
      expect.objectContaining({
        sessionId: 'sess-visible',
        score: 9.5,
      })
    );
  });

  test('SessionService.saveResultAndFinish emits session:finished with submitted result', async () => {
    const finishedAt = new Date('2026-11-25T10:00:00Z');
    SessionRepository.update.mockResolvedValue({
      id: 'sess-1',
      replication: 'rep-1',
      result: 'My solution',
      finishedAt,
    });

    await SessionService.saveResultAndFinish('sess-1', 'My solution');

    expect(mockEmitToSession).toHaveBeenCalledWith('sess-1', 'session:finished', {
      sessionId: 'sess-1',
      finishedAt,
      result: 'My solution',
    });
    expect(mockEmitToReplication).toHaveBeenCalledWith('rep-1', 'session:finished', {
      sessionId: 'sess-1',
      finishedAt,
    });
  });

  test('getSessionForSpectator returns ordered runStages including earlier stages and authorizes switching back to Stage 1', async () => {
    const replication = {
      id: 'rep-1',
      experiment: {
        stages: [
          { id: 'st-1', orchestration: { mode: 'single' } },
          { id: 'st-2', orchestration: { mode: 'single' } },
          { id: 'st-3', orchestration: { mode: 'single' } },
        ],
        leias: [
          {
            id: 'l1',
            stageId: 'st-1',
            configuration: { mode: 'standard' },
            leia: { metadata: { name: 'Interviewer' }, spec: { persona: { spec: { firstName: 'Ana' } } } },
          },
          {
            id: 'l2',
            stageId: 'st-2',
            configuration: { mode: 'standard' },
            leia: { metadata: { name: 'Reviewer' }, spec: { persona: { spec: { firstName: 'Luis' } } } },
          },
        ],
      },
    };

    const sess1 = {
      id: 'sess-1',
      run: 'run-1',
      replication: 'rep-1',
      stageId: 'st-1',
      stageIndex: 0,
      leia: 'l1',
      startedAt: new Date('2026-11-25T09:00:00Z'),
      finishedAt: new Date('2026-11-25T09:10:00Z'),
      result: 'Stage 1 answer',
      messages: ['m1', 'm2'],
    };
    const sess2 = {
      id: 'sess-2',
      run: 'run-1',
      replication: 'rep-1',
      stageId: 'st-2',
      stageIndex: 1,
      leia: 'l2',
      startedAt: new Date('2026-11-25T09:11:00Z'),
      finishedAt: null,
      result: null,
      messages: ['m3'],
    };

    ReplicationRepository.findById.mockResolvedValue(replication);
    SessionRepository.findByRun.mockResolvedValue([sess2, sess1]);
    SessionRepository.findById.mockImplementation(async (id) => {
      if (id === 'sess-1') return sess1;
      if (id === 'sess-2') return sess2;
      return null;
    });

    InteractionService.getSessionData.mockResolvedValue({
      session: {
        id: 'sess-1',
        runId: 'run-1',
        replication: 'rep-1',
        stageId: 'st-1',
        stage: { number: 1, total: 3, hasNext: true },
        result: 'Stage 1 answer',
        finishedAt: sess1.finishedAt,
      },
      messages: [{ id: 'm1', text: 'Hi', isLeia: false }],
      leia: { configuration: { mode: 'standard' }, showEvaluation: false },
      replication: { id: 'rep-1' },
    });

    const res = { json: vi.fn() };
    const next = vi.fn();

    // Token issued for Stage 2 (sess-2) requests Stage 1 (sess-1)
    await getSessionForSpectator(
      { params: { id: 'sess-1' }, spectateSession: 'sess-2', spectateRun: 'run-1' },
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.runStages).toEqual([
      expect.objectContaining({
        sessionId: 'sess-1',
        stageNumber: 1,
        stageTotal: 3,
        isActive: false,
        messageCount: 2,
        hasSubmittedSolution: true,
        leiaName: 'Ana',
      }),
      expect.objectContaining({
        sessionId: 'sess-2',
        stageNumber: 2,
        stageTotal: 3,
        isActive: true,
        messageCount: 1,
        hasSubmittedSolution: false,
        leiaName: 'Luis',
      }),
    ]);
  });

  test('isSessionAuthorizedForSpectateToken supports legacy previousStageSession chains without runId', async () => {
    SessionRepository.findById.mockImplementation(async (id) => {
      if (id === 'legacy-2') return { id: 'legacy-2', previousStageSession: 'legacy-1' };
      if (id === 'legacy-1') return { id: 'legacy-1', previousStageSession: null };
      if (id === 'other-1') return { id: 'other-1', previousStageSession: null };
      return null;
    });

    await expect(
      SpectatorService.isSessionAuthorizedForSpectateToken('legacy-1', {
        spectateSession: 'legacy-2',
        spectateRun: null,
      })
    ).resolves.toBe(true);

    await expect(
      SpectatorService.isSessionAuthorizedForSpectateToken('other-1', {
        spectateSession: 'legacy-2',
        spectateRun: null,
      })
    ).resolves.toBe(false);
  });
});
