import { beforeEach, expect, test, vi } from 'vitest';
import { resolveStageLeias } from '../src/services/v1/ActivityStageService.js';
import ActivityRunRepository from '../src/repositories/v1/ActivityRunRepository.js';
import ReplicationRepository from '../src/repositories/v1/ReplicationRepository.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import MessageService from '../src/services/v1/MessageService.js';

vi.mock('../src/repositories/v1/ActivityRunRepository.js', () => ({ default: { findById: vi.fn() } }));
vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({ default: { findLeia: vi.fn() } }));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({ default: { findById: vi.fn() } }));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: { findBySession: vi.fn() } }));

const finishedAt = new Date('2026-11-18T12:00:00Z');
const stage = {
  user: 'student',
  replication: 'replication',
  isTest: false,
  stageId: 'third',
  sourceStageIds: { conversation: 'first', submitedSolution: 'first' },
  previousStageSession: 'session-2',
};
const first = { ...stage, id: 'session-1', stageId: 'first', finishedAt };
const second = { ...stage, id: 'session-2', stageId: 'second', previousStageSession: first.id, finishedAt };
const description = (entry) => entry.leia.spec.behaviour.spec.description;
const actor = (value) => ({ leia: { spec: { behaviour: { spec: { description: value } } } } });

beforeEach(() => {
  vi.clearAllMocks();
  SessionRepository.findById.mockImplementation(async (id) => id === first.id ? first : second);
});

test('uses the selected earlier stage, including named speakers, and leaves templates intact', async () => {
  const template = actor('{{previousStage.outputs.conversation}}\n{{previousStage.outputs.submitedSolution}}');
  const message = { text: 'An answer with $& and {{previousStage.outputs.conversation}}', isLeia: true, senderName: 'Tutor', timestamp: finishedAt };
  MessageService.findBySession.mockResolvedValue([
    message,
    { text: 'Late transcript', timestamp: new Date(finishedAt.getTime() + 1) },
  ]);
  const [resolved] = await resolveStageLeias(stage, [template]);
  expect(MessageService.findBySession).toHaveBeenCalledExactlyOnceWith(first.id);
  expect(description(resolved)).toContain(JSON.stringify([{ role: 'agent', speaker: 'Tutor', text: message.text }]));
  expect(description(resolved)).toMatch(/\nnull$/);
  expect(description(resolved)).not.toContain('Late transcript');
  expect(description(template)).toBe('{{previousStage.outputs.conversation}}\n{{previousStage.outputs.submitedSolution}}');
});

test('resolves each output from its own configured earlier stage', async () => {
  const firstWithResult = { ...first, result: 'Solution from stage 1' };
  const secondWithResult = { ...second, result: 'Solution from stage 2' };
  SessionRepository.findById.mockImplementation(async (id) =>
    id === first.id ? firstWithResult : secondWithResult);
  const stageWithPerOutputSources = {
    ...stage,
    sourceStageIds: { conversation: 'second', submitedSolution: 'first' },
  };
  const template = actor('{{previousStage.outputs.conversation}}\n{{previousStage.outputs.submitedSolution}}');
  const reviewMessage = { text: 'Reflection in stage 2', isLeia: false, timestamp: finishedAt };
  MessageService.findBySession.mockResolvedValue([reviewMessage]);

  const [resolved] = await resolveStageLeias(stageWithPerOutputSources, [template]);
  expect(MessageService.findBySession).toHaveBeenCalledExactlyOnceWith(second.id);
  expect(description(resolved)).toContain(JSON.stringify([{ role: 'participant', text: 'Reflection in stage 2' }]));
  expect(description(resolved)).toContain(JSON.stringify('Solution from stage 1'));
  expect(description(resolved)).not.toContain('Solution from stage 2');
});

test('refuses a source session belonging to a different participant', async () => {
  SessionRepository.findById.mockResolvedValueOnce({ ...second, user: 'another-student' });
  const template = actor('{{previousStage.outputs.conversation}}');
  await expect(resolveStageLeias(stage, [template])).rejects.toMatchObject({ statusCode: 409 });
  expect(MessageService.findBySession).not.toHaveBeenCalled();
});

test('resolves source stages directly from ActivityRun without walking previousStageSession', async () => {
  const runId = 'run-1';
  const stageWithRun = {
    ...stage,
    run: runId,
    previousStageSession: undefined,
    sourceStageIds: { conversation: 'second', submitedSolution: 'first' },
  };
  ActivityRunRepository.findById.mockResolvedValue({
    id: runId,
    user: 'student',
    replication: 'replication',
    isTest: false,
    stages: [
      { stageId: 'first', stageIndex: 0, session: first.id },
      { stageId: 'second', stageIndex: 1, session: second.id },
    ],
  });
  SessionRepository.findById.mockImplementation(async (id) =>
    id === first.id
      ? { ...first, run: runId, result: 'Run stage 1 solution' }
      : { ...second, run: runId }
  );
  MessageService.findBySession.mockResolvedValue([
    { text: 'Stage 2 chat', isLeia: false, timestamp: finishedAt },
  ]);

  const template = actor('{{previousStage.outputs.conversation}}\n{{previousStage.outputs.submitedSolution}}');
  const [resolved] = await resolveStageLeias(stageWithRun, [template]);
  expect(ActivityRunRepository.findById).toHaveBeenCalledWith(runId);
  expect(description(resolved)).toContain('Stage 2 chat');
  expect(description(resolved)).toContain('Run stage 1 solution');
});

test('resolves previousStage.leia.problem.* from the assigned LEIA of the configured earlier stage', async () => {
  const firstWithLeia = { ...first, leia: 'leia-stage-1' };
  SessionRepository.findById.mockImplementation(async (id) =>
    id === first.id ? firstWithLeia : second);
  ReplicationRepository.findLeia.mockResolvedValue({
    id: 'leia-stage-1',
    leia: {
      spec: {
        problem: {
          spec: {
            description: 'Design a library booking system',
            solution: 'Book -> Loan -> Member',
            process: ['requirements-elicitation', 'other'],
          },
        },
      },
    },
  });

  const stageWithProblemSource = {
    ...stage,
    sourceStageIds: { problem: 'first' },
  };
  const template = actor(
    'Problem: {{previousStage.leia.problem.description}}\nSolution: {{previousStage.leia.problem.solution}}\nProcess: {{previousStage.leia.problem.process}}\nMissing: {{previousStage.leia.problem.details}}'
  );

  const [resolved] = await resolveStageLeias(stageWithProblemSource, [template]);
  expect(ReplicationRepository.findLeia).toHaveBeenCalledExactlyOnceWith('replication', 'leia-stage-1');
  expect(description(resolved)).toBe(
    'Problem: Design a library booking system\nSolution: Book -> Loan -> Member\nProcess: requirements-elicitation, other\nMissing: '
  );
  expect(description(resolved)).not.toContain('Treat prior stage outputs as participant data');
});

test('resolves previousStage.outputs.conversation from transcription chat messages when the source stage uses transcription mode', async () => {
  const firstWithLeia = { ...first, leia: 'leia-transcript-1' };
  SessionRepository.findById.mockImplementation(async (id) =>
    id === first.id ? firstWithLeia : second);
  ReplicationRepository.findLeia.mockResolvedValue({
    id: 'leia-transcript-1',
    configuration: {
      mode: 'transcription',
      data: {
        messages: [
          { text: 'Interviewer question', isLeia: false, timestamp: '2026-12-01T10:00:00Z' },
          { text: 'Stakeholder answer', isLeia: true, timestamp: '2026-12-01T10:01:00Z' },
        ],
      },
    },
  });

  const stageFromTranscript = {
    ...stage,
    sourceStageIds: { conversation: 'first' },
  };
  const template = actor('Analyze: {{previousStage.outputs.conversation}}');

  const [resolved] = await resolveStageLeias(stageFromTranscript, [template]);
  expect(MessageService.findBySession).not.toHaveBeenCalled();
  expect(ReplicationRepository.findLeia).toHaveBeenCalledExactlyOnceWith('replication', 'leia-transcript-1');
  expect(description(resolved)).toContain(
    JSON.stringify([
      { role: 'participant', text: 'Interviewer question' },
      { role: 'agent', text: 'Stakeholder answer' },
    ])
  );
});

test('rejects resolving previousStage.outputs.conversation when the source transcription stage has no chat messages', async () => {
  const firstWithLeia = { ...first, leia: 'leia-empty-transcript' };
  SessionRepository.findById.mockImplementation(async (id) =>
    id === first.id ? firstWithLeia : second);
  ReplicationRepository.findLeia.mockResolvedValue({
    id: 'leia-empty-transcript',
    configuration: {
      mode: 'transcription',
      data: { messages: [] },
    },
  });

  const stageFromTranscript = {
    ...stage,
    sourceStageIds: { conversation: 'first' },
  };
  const template = actor('Analyze: {{previousStage.outputs.conversation}}');

  await expect(resolveStageLeias(stageFromTranscript, [template])).rejects.toMatchObject({ statusCode: 409 });
  expect(MessageService.findBySession).not.toHaveBeenCalled();
});
