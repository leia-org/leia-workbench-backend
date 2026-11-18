import { beforeEach, expect, test, vi } from 'vitest';
import { resolveStageLeias } from '../src/services/v1/ActivityStageService.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import MessageService from '../src/services/v1/MessageService.js';

vi.mock('../src/repositories/v1/SessionRepository.js', () => ({ default: { findById: vi.fn() } }));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: { findBySession: vi.fn() } }));

const finishedAt = new Date('2026-11-18T12:00:00Z');
const stage = {
  user: 'student',
  replication: 'replication',
  isTest: false,
  stageId: 'third',
  sourceStageId: 'first',
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

test('refuses a source session belonging to a different participant', async () => {
  SessionRepository.findById.mockResolvedValueOnce({ ...second, user: 'another-student' });
  const template = actor('{{previousStage.outputs.conversation}}');
  await expect(resolveStageLeias(stage, [template])).rejects.toMatchObject({ statusCode: 409 });
  expect(MessageService.findBySession).not.toHaveBeenCalled();
});
