import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

import axios from 'axios';
import RunnerService from '../src/services/v1/RunnerService.js';
import {
  startTestSessionValidator,
  streamSessionMessageValidator,
} from '../src/validators/v1/interactionValidator.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MultiLEIA interaction contract', () => {
  test('allows testing the complete graph without an individual leiaId', async () => {
    const value = await startTestSessionValidator.validateAsync({
      replicationId: '507f1f77bcf86cd799439011',
      multiLeia: true,
    });

    expect(value.multiLeia).toBe(true);
    expect(value.leiaId).toBeUndefined();
  });

  test('keeps leiaId mandatory for a single-LEIA test', async () => {
    await expect(
      startTestSessionValidator.validateAsync({
        replicationId: '507f1f77bcf86cd799439011',
      })
    ).rejects.toThrow();
  });

  test('sends separate opening and shared-problem actors to the runner', async () => {
    axios.post.mockResolvedValue({ data: { state: { status: 'awaiting_user' } } });
    const leias = [
      {
        id: '507f1f77bcf86cd799439012',
        leia: { metadata: { name: 'Analyst' }, spec: {} },
        runnerConfiguration: { modelName: 'model-a' },
      },
      {
        id: '507f1f77bcf86cd799439013',
        leia: { metadata: { name: 'Reviewer' }, spec: {} },
        runnerConfiguration: { modelName: 'model-b' },
      },
    ];

    await RunnerService.initializeMultiLeia('session-1', leias, {
      maxInternalTurns: 2,
      openingLeiaId: leias[0].id,
      problemLeiaId: leias[1].id,
      sharedTask: 'Review the proposed requirements.',
    });

    expect(axios.post).toHaveBeenCalledWith(
      `${process.env.RUNNER_URL}/api/v1/multi-leias`,
      expect.objectContaining({
        sessionId: 'session-1',
        orchestration: {
          maxInternalTurns: 2,
          openingActorId: leias[0].id,
          problemActorId: leias[1].id,
          sharedTask: 'Review the proposed requirements.',
        },
      }),
      expect.any(Object)
    );
  });

  test('streams each actor message before the completion event', async () => {
    const message = {
      sequence: 2,
      senderId: 'actor-a',
      senderName: 'Actor A',
      text: 'Hello from A',
    };
    axios.post.mockResolvedValue({
      data: Readable.from([
        'event: ready\ndata: {"connected":true}\n\n',
        'event: route\ndata: {"nextActorId":"actor-a"}\n\n',
        `event: message\ndata: ${JSON.stringify({ message })}\n`,
        '\nevent: complete\ndata: {"state":{"status":"awaiting_user"}}\n\n',
      ]),
    });
    const onMessage = vi.fn();
    const onRoute = vi.fn();

    const result = await RunnerService.streamMultiLeiaMessage(
      'session-1',
      'Hello',
      'turn-1',
      { onMessage, onRoute }
    );

    expect(onRoute).toHaveBeenCalledWith({ nextActorId: 'actor-a' });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(message);
    expect(result).toEqual({ state: { status: 'awaiting_user' } });
    expect(axios.post).toHaveBeenCalledWith(
      `${process.env.RUNNER_URL}/api/v1/multi-leias/session-1/messages/stream`,
      { message: 'Hello', turnId: 'turn-1' },
      expect.objectContaining({ responseType: 'stream' })
    );
  });

  test('requires a text message for the group-chat stream', async () => {
    await expect(streamSessionMessageValidator.validateAsync({ message: '  ' }))
      .rejects.toThrow();
  });
});
