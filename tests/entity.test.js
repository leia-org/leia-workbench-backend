import { describe, expect, test } from 'vitest';
import { initializeExperiment } from '../src/utils/entity.js';

describe('initializeExperiment', () => {
  test('configura cada LEIA en modo texto con el modelo por defecto del usuario', () => {
    const experiment = {
      leias: [
        {
          configuration: {
            mode: 'transcription',
            askSolution: false,
            evaluateSolution: false,
          },
        },
      ],
    };

    const result = initializeExperiment(
      experiment,
      { id: 'key1', model: 'gpt-4.1-mini' },
      'user1',
      'openai-responses'
    );

    expect(result.leias[0].configuration.mode).toBe('standard');
    expect(result.leias[0].runnerConfiguration).toMatchObject({
      modelName: 'gpt-4.1-mini',
      apiKeyId: 'key1',
      apiKeyRequesterId: 'user1',
      provider: 'openai-responses',
      audioMode: null,
    });
  });
});
