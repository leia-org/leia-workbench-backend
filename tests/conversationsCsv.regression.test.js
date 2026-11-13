import { describe, expect, test, beforeEach, vi } from 'vitest';

// El CSV de conversaciones lo consume el análisis de investigación, que valida
// sus columnas. Los test runs se exportan en un fichero aparte y no deben
// alterar este formato.
vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({ default: {} }));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({
  default: { findByReplicationAndPopulateMessages: vi.fn() },
}));
vi.mock('../src/services/v1/ManagerService.js', () => ({ default: {} }));
vi.mock('../src/utils/entity.js', () => ({ initializeExperiment: vi.fn() }));
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import ReplicationService from '../src/services/v1/ReplicationService.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getConversationsCSV — formato estable', () => {
  test('mantiene la cabecera y una fila por mensaje', async () => {
    SessionRepository.findByReplicationAndPopulateMessages.mockResolvedValue([
      {
        id: 's1',
        user: { email: 'ana@example.com' },
        startedAt: new Date('2026-11-13T10:00:00.000Z'),
        finishedAt: new Date('2026-11-13T10:30:00.000Z'),
        score: 7,
        evaluation: 'Good',
        messages: [
          { text: 'hello', isLeia: false, timestamp: new Date('2026-11-13T10:01:00.000Z') },
          { text: 'hi, "student"', isLeia: true, timestamp: new Date('2026-11-13T10:01:05.000Z') },
        ],
        // Aunque una sesión llevara test runs, no aparecen en este fichero.
        testRuns: [{ id: 'tr1', status: 'failed' }],
      },
    ]);

    const csv = await ReplicationService.getConversationsCSV('rep1');
    const lines = csv.trimEnd().split('\n');

    expect(lines[0]).toBe('Session ID,User,Started At,Finished At,Message,Is LEIA,Timestamp,Score,Evaluation');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      's1,ana@example.com,2026-11-13T10:00:00.000Z,2026-11-13T10:30:00.000Z,"hello",FALSE,2026-11-13T10:01:00.000Z,7,"Good"'
    );
    expect(lines[2]).toContain('"hi, ""student""",TRUE,');
    expect(csv).not.toContain('tr1');
  });
});
