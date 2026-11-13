import { describe, expect, test, beforeEach, vi } from 'vitest';

// Aislamos el servicio de la base de datos y de los sockets.
vi.mock('../src/repositories/v1/TestRunRepository.js', () => ({
  default: {
    create: vi.fn(),
    countBySession: vi.fn(),
    findBySessionAndClientRunId: vi.fn(),
    findSummariesByReplication: vi.fn(),
    findByReplication: vi.fn(),
    findBySessionAndReplication: vi.fn(),
    findUnreportedStudentRuns: vi.fn(),
    countUnreportedStudentRuns: vi.fn(),
    markStudentRunsReported: vi.fn(),
  },
}));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({
  default: { findById: vi.fn(), findByReplicationWithUser: vi.fn() },
}));
vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({
  default: { findLeia: vi.fn() },
}));
vi.mock('../src/socket/index.js', () => ({ emitToReplication: vi.fn() }));
vi.mock('../src/utils/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import TestRunRepository from '../src/repositories/v1/TestRunRepository.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import ReplicationRepository from '../src/repositories/v1/ReplicationRepository.js';
import { emitToReplication } from '../src/socket/index.js';
import TestRunService, {
  MAX_RUNS_PER_SESSION,
  TEST_RUNS_CSV_HEADER,
  deriveOutcome,
  hasCodeEditorWidget,
} from '../src/services/v1/TestRunService.js';

const codeEditorLeia = { leia: { spec: { problem: { spec: { widgets: [{ widgetType: 'codeEditor' }] } } } } };

const session = { id: 's1', replication: 'rep1', leia: 'leia1', isTest: false };

const payload = {
  clientRunId: 'run-1',
  trigger: 'student',
  language: 'javascript',
  fnName: 'twoSum',
  code: 'function twoSum() {}',
  codeTruncated: false,
  results: [
    { name: 't1', ok: true },
    { name: 't2', ok: false, expected: '[0,1]', actual: 'undefined' },
  ],
  error: null,
  durationMs: 12,
};

beforeEach(() => {
  vi.clearAllMocks();
  SessionRepository.findById.mockResolvedValue(session);
  ReplicationRepository.findLeia.mockResolvedValue(codeEditorLeia);
  TestRunRepository.findBySessionAndClientRunId.mockResolvedValue(null);
  TestRunRepository.countBySession.mockResolvedValue(0);
  TestRunRepository.create.mockImplementation(async (data) => ({
    ...data,
    id: 'tr1',
    createdAt: new Date('2026-11-13T10:00:00.000Z'),
  }));
});

describe('record — guardado de una ejecución de tests', () => {
  test('calcula contadores y estado en el servidor a partir de los resultados', async () => {
    const { run, created } = await TestRunService.record('s1', { ...payload, passed: 99, status: 'passed' });

    expect(created).toBe(true);
    expect(TestRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        session: 's1',
        replication: 'rep1',
        trigger: 'student',
        code: 'function twoSum() {}',
        passed: 1,
        failed: 1,
        total: 2,
        status: 'failed',
      })
    );
    expect(run.id).toBe('tr1');
  });

  test('un error de la suite marca la ejecución como error', async () => {
    await TestRunService.record('s1', { ...payload, results: [], error: 'SyntaxError: Unexpected token' });

    expect(TestRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', total: 0, error: 'SyntaxError: Unexpected token' })
    );
  });

  test('avisa al dashboard sin incluir el código', async () => {
    TestRunRepository.countBySession.mockResolvedValue(4);

    await TestRunService.record('s1', payload);

    expect(emitToReplication).toHaveBeenCalledTimes(1);
    const [replicationId, event, data] = emitToReplication.mock.calls[0];
    expect(replicationId).toBe('rep1');
    expect(event).toBe('session:testRun');
    expect(data.sessionId).toBe('s1');
    expect(data.testRunCount).toBe(5);
    expect(data.testRun).not.toHaveProperty('code');
    expect(data.testRun.status).toBe('failed');
  });

  test('guarda pero no emite para sesiones de prueba', async () => {
    SessionRepository.findById.mockResolvedValue({ ...session, isTest: true });

    const { created } = await TestRunService.record('s1', payload);

    expect(created).toBe(true);
    expect(emitToReplication).not.toHaveBeenCalled();
  });

  test('un clientRunId repetido devuelve la ejecución existente sin duplicar', async () => {
    const existing = { id: 'tr0', createdAt: new Date() };
    TestRunRepository.findBySessionAndClientRunId.mockResolvedValue(existing);

    const result = await TestRunService.record('s1', payload);

    expect(result).toEqual({ run: existing, created: false });
    expect(TestRunRepository.create).not.toHaveBeenCalled();
    expect(emitToReplication).not.toHaveBeenCalled();
  });

  test('una carrera entre dos envíos iguales se resuelve con la ejecución ya guardada', async () => {
    const existing = { id: 'tr0', createdAt: new Date() };
    TestRunRepository.findBySessionAndClientRunId.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    TestRunRepository.create.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 }));

    await expect(TestRunService.record('s1', payload)).resolves.toEqual({ run: existing, created: false });
  });

  test('rechaza una sesión inexistente', async () => {
    SessionRepository.findById.mockResolvedValue(null);
    await expect(TestRunService.record('nope', payload)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('rechaza una sesión ya terminada', async () => {
    SessionRepository.findById.mockResolvedValue({ ...session, finishedAt: new Date() });
    await expect(TestRunService.record('s1', payload)).rejects.toMatchObject({ statusCode: 403 });
    expect(TestRunRepository.create).not.toHaveBeenCalled();
  });

  test('rechaza actividades sin editor de código', async () => {
    ReplicationRepository.findLeia.mockResolvedValue({ leia: { spec: { problem: { spec: { widgets: [] } } } } });
    await expect(TestRunService.record('s1', payload)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('rechaza al superar el tope de ejecuciones por sesión', async () => {
    TestRunRepository.countBySession.mockResolvedValue(MAX_RUNS_PER_SESSION);
    await expect(TestRunService.record('s1', payload)).rejects.toMatchObject({ statusCode: 429 });
    expect(TestRunRepository.create).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  test('hasCodeEditorWidget lee los widgets del problema y el formato heredado', () => {
    expect(hasCodeEditorWidget(codeEditorLeia)).toBe(true);
    expect(
      hasCodeEditorWidget({ runnerConfiguration: { lukeConfig: { widgets: [{ widgetType: 'codeEditor' }] } } })
    ).toBe(true);
    expect(hasCodeEditorWidget({ leia: { spec: { problem: { spec: { widgets: [{ widgetType: 'other' }] } } } } })).toBe(
      false
    );
    expect(hasCodeEditorWidget(null)).toBe(false);
  });

  test('deriveOutcome distingue aprobado, fallado y error', () => {
    expect(deriveOutcome([{ ok: true }, { ok: true }], null)).toEqual({ passed: 2, failed: 0, total: 2, status: 'passed' });
    expect(deriveOutcome([{ ok: true }, { ok: false }], null)).toMatchObject({ failed: 1, status: 'failed' });
    expect(deriveOutcome([], 'timeout')).toMatchObject({ total: 0, status: 'error' });
  });
});

describe('lecturas para el instructor', () => {
  const runs = [
    { id: 'a', session: 's1', status: 'failed', createdAt: new Date('2026-11-13T10:00:00Z') },
    { id: 'b', session: 's2', status: 'passed', createdAt: new Date('2026-11-13T10:01:00Z') },
    { id: 'c', session: 's1', status: 'passed', createdAt: new Date('2026-11-13T10:02:00Z') },
  ];

  test('attachSummaries añade las ejecuciones de cada sesión, sin código', async () => {
    TestRunRepository.findSummariesByReplication.mockResolvedValue(
      runs.map((run) => ({ toJSON: () => ({ ...run, code: 'secret' }) }))
    );
    const sessions = [{ toJSON: () => ({ id: 's1', messages: [] }) }, { id: 's3', messages: [] }];

    const result = await TestRunService.attachSummaries('rep1', sessions);

    expect(result[0].testRuns.map((run) => run.id)).toEqual(['a', 'c']);
    expect(result[0].testRuns[0]).not.toHaveProperty('code');
    expect(result[1].testRuns).toEqual([]);
  });

  test('liveSummariesBySession devuelve el total y solo las últimas ejecuciones', async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ id: `r${index}`, session: 's1' }));
    TestRunRepository.findSummariesByReplication.mockResolvedValue(many);

    const live = await TestRunService.liveSummariesBySession('rep1');

    expect(live.get('s1').testRunCount).toBe(8);
    expect(live.get('s1').testRuns.map((run) => run.id)).toEqual(['r3', 'r4', 'r5', 'r6', 'r7']);
  });

  test('findForSession filtra por sesión y replicación', async () => {
    TestRunRepository.findBySessionAndReplication.mockResolvedValue([]);
    await TestRunService.findForSession('rep1', 's1');
    expect(TestRunRepository.findBySessionAndReplication).toHaveBeenCalledWith('s1', 'rep1');
  });
});

describe('getReplicationCSV — una fila por ejecución', () => {
  test('cabecera, numeración por sesión, escapado y sesiones de prueba excluidas', async () => {
    SessionRepository.findByReplicationWithUser.mockResolvedValue([
      { id: 's1', user: { email: 'ana@example.com' } },
      { id: 's2', user: null },
    ]);
    TestRunRepository.findByReplication.mockResolvedValue([
      {
        id: 'tr1',
        session: 's1',
        trigger: 'student',
        language: 'javascript',
        fnName: 'twoSum',
        status: 'failed',
        passed: 1,
        failed: 1,
        total: 2,
        durationMs: 12,
        error: null,
        results: [
          { name: 'basic', ok: true },
          { name: 'with "quotes", commas', ok: false, expected: '[0,1]', actual: 'undefined' },
        ],
        reportedToLeiaAt: new Date('2026-11-13T10:05:00.000Z'),
        codeTruncated: false,
        code: 'function twoSum(a, b) {\n  return "x";\n}',
        createdAt: new Date('2026-11-13T10:00:00.000Z'),
      },
      {
        id: 'tr2',
        session: 's1',
        trigger: 'leia',
        language: 'javascript',
        fnName: 'twoSum',
        status: 'error',
        passed: 0,
        failed: 0,
        total: 0,
        durationMs: 3,
        error: 'SyntaxError',
        results: [],
        reportedToLeiaAt: null,
        codeTruncated: true,
        code: '@decorator',
        createdAt: new Date('2026-11-13T10:10:00.000Z'),
      },
      // Ejecución de una sesión de prueba: su sesión no está en la lista.
      { id: 'tr3', session: 'test-session', results: [], createdAt: new Date() },
    ]);

    const csv = await TestRunService.getReplicationCSV('rep1');
    const [header] = csv.split('\n');

    expect(header).toBe(TEST_RUNS_CSV_HEADER.join(','));
    expect(header).toBe(
      'Session ID,User,Run ID,Run Number,Timestamp,Trigger,Language,Function,Status,Passed,Failed,Total,Duration Ms,Error,Failed Tests,Results JSON,Reported To LEIA At,Code Truncated,Code'
    );

    expect(csv).toContain(
      's1,ana@example.com,tr1,1,2026-11-13T10:00:00.000Z,student,javascript,twoSum,failed,1,1,2,12,,"with ""quotes"", commas",'
    );
    // El código multilínea va entre comillas con las comillas internas dobladas.
    expect(csv).toContain(',FALSE,"function twoSum(a, b) {\n  return ""x"";\n}"\n');
    // Segunda ejecución de la misma sesión: número 2, sin prefijo anti-fórmulas.
    expect(csv).toContain('s1,ana@example.com,tr2,2,2026-11-13T10:10:00.000Z,leia,javascript,twoSum,error,0,0,0,3,SyntaxError,,[],,TRUE,@decorator\n');
    expect(csv).not.toContain('tr3');
  });

  test('sin ejecuciones devuelve solo la cabecera', async () => {
    SessionRepository.findByReplicationWithUser.mockResolvedValue([{ id: 's1', user: null }]);
    TestRunRepository.findByReplication.mockResolvedValue([]);

    const csv = await TestRunService.getReplicationCSV('rep1');

    expect(csv).toBe(`${TEST_RUNS_CSV_HEADER.join(',')}\n`);
  });
});

describe('pendingNote / markReported — aviso al LEIA', () => {
  test('sin ejecuciones pendientes no hay nota', async () => {
    TestRunRepository.findUnreportedStudentRuns.mockResolvedValue([]);
    await expect(TestRunService.pendingNote('s1')).resolves.toBeNull();
  });

  test('devuelve el contexto y la fecha de la última ejecución descrita', async () => {
    const latest = new Date('2026-11-13T10:02:00.000Z');
    TestRunRepository.findUnreportedStudentRuns.mockResolvedValue([
      { status: 'failed', passed: 0, total: 2, results: [], language: 'python', createdAt: new Date('2026-11-13T10:00:00Z') },
      { status: 'passed', passed: 2, total: 2, results: [], language: 'python', createdAt: latest },
    ]);

    const note = await TestRunService.pendingNote('s1', new Date('2026-11-13T10:05:00.000Z'));

    expect(note.upTo).toBe(latest);
    expect(note.context).toContain('2 times');
    expect(note.context).toContain('All 2 tests passed.');
    expect(TestRunRepository.countUnreportedStudentRuns).not.toHaveBeenCalled();
  });

  test('markReported sella hasta la fecha indicada', async () => {
    const upTo = new Date();
    await TestRunService.markReported('s1', upTo);
    expect(TestRunRepository.markStudentRunsReported).toHaveBeenCalledWith('s1', upTo);
  });
});
