import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({
  default: {
    findById: vi.fn(),
    updateEvaluationConfiguration: vi.fn(async (_id, _leiaId, fields) => ({ updated: fields })),
    updateAskSolution: vi.fn(async (_id, _leiaId, askSolution, opts) => ({ askSolution, opts })),
    updateShowSolution: vi.fn(async (_id, _leiaId, showSolution) => ({ showSolution })),
    updateAskSolutionAndShowSolution: vi.fn(async (_id, _leiaId, askSolution, showSolution) => ({ askSolution, showSolution })),
  },
}));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({
  default: {
    findByReplicationAndPopulateMessages: vi.fn(),
  },
}));
vi.mock('../src/services/v1/ManagerService.js', () => ({ default: {} }));

import ReplicationRepository from '../src/repositories/v1/ReplicationRepository.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import ReplicationService from '../src/services/v1/ReplicationService.js';
import { getStageReferencedOutputs } from '../src/utils/activityStages.js';
import {
  collectRubricCsvColumns,
  extractRubricCsvValues,
  resolveEvaluationMode,
  rubricRequiresSubmittedSolution,
} from '../src/utils/rubricEvaluation.js';

const sampleRubric = (evaluationPrompt = '') => ({
  apiVersion: 'v1',
  metadata: { name: 'Interview Rubric' },
  spec: {
    ...(evaluationPrompt ? { evaluationPrompt } : {}),
    sections: [
      {
        title: 'Understanding',
        weight: 100,
        levels: ['Low', 'High'],
        criteria: [
          {
            name: 'Depth',
            descriptors: [
              { level: 'Low', description: 'Shallow' },
              { level: 'High', description: 'Deep' },
            ],
          },
        ],
      },
    ],
  },
});

const makeReplication = ({
  solution = 'Expected answer',
  rubric = sampleRubric(),
  askSolution = false,
  evaluateSolution = false,
  evaluationMode = 'none',
  showSolution = false,
} = {}) => ({
  id: 'rep-1',
  experiment: {
    leias: [
      {
        id: 'leia-1',
        configuration: { askSolution, evaluateSolution, evaluationMode, showSolution },
        leia: {
          id: 'doc-1',
          metadata: { name: 'Coach LEIA' },
          spec: {
            problem: { spec: { solution } },
            behaviour: { spec: { description: 'Coach' } },
            ...(rubric ? { rubric } : {}),
          },
        },
      },
    ],
  },
});

describe('workbench rubric evaluation configuration & CSV', () => {
  beforeEach(() => vi.clearAllMocks());

  test('resolves legacy evaluateSolution and detects rubric placeholders', () => {
    expect(resolveEvaluationMode({ evaluateSolution: true })).toBe('classic');
    expect(resolveEvaluationMode({ evaluateSolution: false })).toBe('none');
    expect(resolveEvaluationMode({ evaluateSolution: true, evaluationMode: 'rubric' })).toBe('rubric');
    expect(
      rubricRequiresSubmittedSolution({
        leia: { spec: { rubric: sampleRubric('Check {{currentStage.outputs.submitedSolution}}') } },
      }),
    ).toBe(true);
    expect(
      rubricRequiresSubmittedSolution({
        leia: { spec: { rubric: sampleRubric('Check {{currentStage.outputs.conversation}}') } },
      }),
    ).toBe(false);
    expect([
      ...getStageReferencedOutputs([
        {
          leia: {
            spec: {
              behaviour: { spec: { description: 'Base' } },
              rubric: sampleRubric('Compare with {{previousStage.outputs.conversation}} and {{previousStage.leia.problem.description}}'),
            },
          },
        },
      ]),
    ]).toEqual(['conversation', 'problem']);
  });

  test('allows rubric evaluation without askSolution when rubric does not require submitted solution', async () => {
    ReplicationRepository.findById.mockResolvedValue(
      makeReplication({ solution: '', rubric: sampleRubric('Use {{currentStage.outputs.conversation}}'), askSolution: false }),
    );

    const res = await ReplicationService.updateEvaluationMode('rep-1', 'leia-1', 'rubric');
    expect(res.updated).toEqual({ evaluationMode: 'rubric', evaluateSolution: true });
  });

  test('enables askSolution automatically when rubric requires submitted solution and blocks disabling it', async () => {
    ReplicationRepository.findById.mockResolvedValue(
      makeReplication({
        rubric: sampleRubric('Grade {{currentStage.outputs.submitedSolution}}'),
        askSolution: false,
      }),
    );

    const res = await ReplicationService.updateEvaluationMode('rep-1', 'leia-1', 'rubric');
    expect(res.updated).toEqual({
      evaluationMode: 'rubric',
      evaluateSolution: true,
      askSolution: true,
    });

    ReplicationRepository.findById.mockResolvedValue(
      makeReplication({
        rubric: sampleRubric('Grade {{currentStage.outputs.submitedSolution}}'),
        askSolution: true,
        evaluateSolution: true,
        evaluationMode: 'rubric',
      }),
    );
    await expect(ReplicationService.toggleAskSolution('rep-1', 'leia-1')).rejects.toThrow(
      /rubric evaluation prompt references the submitted solution/i,
    );
  });

  test('enforces availability when switching between classic and rubric modes', async () => {
    ReplicationRepository.findById.mockResolvedValue(makeReplication({ solution: '', rubric: sampleRubric() }));
    await expect(ReplicationService.updateEvaluationMode('rep-1', 'leia-1', 'classic')).rejects.toThrow(
      /reference solution/i,
    );

    ReplicationRepository.findById.mockResolvedValue(makeReplication({ solution: 'Ref', rubric: null }));
    await expect(ReplicationService.updateEvaluationMode('rep-1', 'leia-1', 'rubric')).rejects.toThrow(
      /requires a rubric/i,
    );
  });

  test('exports CSV with Evaluation Mode and dynamic rubric section/criterion columns', async () => {
    const replication = makeReplication({ rubric: sampleRubric() });
    const sessions = [
      {
        id: 'sess-1',
        leia: 'leia-1',
        user: { email: 'student@example.com' },
        startedAt: '2026-11-22T00:00:00.000Z',
        finishedAt: '2026-11-22T00:10:00.000Z',
        evaluationMode: 'rubric',
        score: 10,
        evaluation: '## Interview Rubric — 10/10',
        result: 'My solution',
        rubricEvaluation: {
          rubricName: 'Interview Rubric',
          scale: 10,
          totalScore: 10,
          summary: 'Great',
          sections: [
            {
              title: 'Understanding',
              weight: 100,
              score: 10,
              criteria: [{ name: 'Depth', selectedLevel: 'High', score: 10, justification: 'Clear' }],
            },
          ],
        },
        messages: [
          { text: 'Hi', isLeia: false, timestamp: '2026-11-22T00:01:00.000Z' },
        ],
      },
    ];
    ReplicationRepository.findById.mockResolvedValue(replication);
    SessionRepository.findByReplicationAndPopulateMessages.mockResolvedValue(sessions);

    const cols = collectRubricCsvColumns(replication, sessions);
    expect(cols.map((c) => c.header)).toEqual([
      'Rubric: Understanding [100%] (Score)',
      'Rubric: Understanding - Depth (Level)',
      'Rubric: Understanding - Depth (Score)',
    ]);
    expect(extractRubricCsvValues(sessions[0].rubricEvaluation, cols)).toEqual([10, 'High', 10]);

    const csv = await ReplicationService.getConversationsCSV('rep-1');
    const [headerLine, rowLine] = csv.trim().split('\n');
    expect(headerLine).toContain('Evaluation Mode,Score,Evaluation,Submitted Solution');
    expect(headerLine).toContain('Rubric: Understanding [100%] (Score)');
    expect(headerLine).toContain('Rubric: Understanding - Depth (Level)');
    expect(rowLine).toContain(',rubric,10,## Interview Rubric — 10/10,My solution,10,High,10');
  });
});
