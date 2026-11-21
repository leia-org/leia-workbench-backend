import { beforeEach, expect, test, vi } from 'vitest';
import { resolveStageLeias } from '../src/services/v1/ActivityStageService.js';
import ActivityRunRepository from '../src/repositories/v1/ActivityRunRepository.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import MessageService from '../src/services/v1/MessageService.js';

vi.mock('../src/repositories/v1/ActivityRunRepository.js', () => ({ default: { findById: vi.fn() } }));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({ default: { findById: vi.fn() } }));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: { findBySession: vi.fn() } }));

const finishedAt = new Date('2026-11-18T12:00:00Z');
const runId = 'run-1';
const stage = {
  run: runId,
  user: 'student',
  replication: 'replication',
  isTest: false,
  stageId: 'third',
  sourceStageIds: { conversation: 'first', submitedSolution: 'first' },
};
const first = { ...stage, id: 'session-1', stageId: 'first', finishedAt };
const second = { ...stage, id: 'session-2', stageId: 'second', finishedAt };
const description = (entry) => entry.leia.spec.behaviour.spec.description;
const actor = (value) => ({ leia: { spec: { behaviour: { spec: { description: value } } } } });

beforeEach(() => {
  vi.clearAllMocks();
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
  SessionRepository.findById.mockResolvedValueOnce({ ...first, user: 'another-student' });
  const template = actor('{{previousStage.outputs.conversation}}');
  await expect(resolveStageLeias(stage, [template])).rejects.toMatchObject({ statusCode: 409 });
  expect(MessageService.findBySession).not.toHaveBeenCalled();
});

test('resolves source stages directly from ActivityRun', async () => {
  const stageWithRun = {
    ...stage,
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
