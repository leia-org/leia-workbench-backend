import { describe, expect, test, beforeEach, vi } from 'vitest';

// Los test runs se guardan como eventos de tipo test_run. Aislamos la vista
// tipada de la base de datos y de los sockets; EventService es el real.
vi.mock('../src/repositories/v1/EventRepository.js', () => ({
  default: {
    findByClientEventIds: vi.fn(),
    findBySessionAndClientEventId: vi.fn(),
    countsByTypeForSession: vi.fn(),
    findBySession: vi.fn(),
    findByReplication: vi.fn(),
    findUnreported: vi.fn(),
    countUnreported: vi.fn(),
    create: vi.fn(),
    markReported: vi.fn(),
  },
}));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({
  default: { findById: vi.fn(), findByReplicationWithUser: vi.fn() },
}));
vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({
  default: { findLeia: vi.fn(), findById: vi.fn() },
}));
vi.mock('../src/socket/index.js', () => ({ emitToReplication: vi.fn() }));
vi.mock('../src/utils/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import EventRepository from '../src/repositories/v1/EventRepository.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';
import ReplicationRepository from '../src/repositories/v1/ReplicationRepository.js';
import { emitToReplication } from '../src/socket/index.js';
import TestRunService, {
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

// Un evento test_run tal como lo devuelve el repositorio.
const runEvent = (overrides = {}) => ({
  id: 'e1',
  session: 's1',
  replication: 'rep1',
  type: 'test_run',
  source: 'code_editor',
  actor: 'student',
  clientEventId: 'run-1',
  clientAt: new Date('2026-11-13T09:59:59.000Z'),
  createdAt: new Date('2026-11-13T10:00:00.000Z'),
  contentTruncated: false,
  payload: {
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
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  SessionRepository.findById.mockResolvedValue(session);
  ReplicationRepository.findLeia.mockResolvedValue(codeEditorLeia);
  ReplicationRepository.findById.mockResolvedValue({ experiment: {} });
  EventRepository.findByClientEventIds.mockResolvedValue([]);
  EventRepository.countsByTypeForSession.mockResolvedValue({});
  EventRepository.create.mockImplementation(async (data) => ({
    ...data,
    id: 'tr1',
    createdAt: new Date('2026-11-13T10:00:00.000Z'),
  }));
});

describe('record — un test run se guarda como evento test_run', () => {
  test('calcula contadores y estado en el servidor y devuelve la vista de test run', async () => {
    const { run, created } = await TestRunService.record('s1', { ...payload, passed: 99, status: 'passed' });

    expect(created).toBe(true);
    expect(EventRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        session: 's1',
        replication: 'rep1',
        type: 'test_run',
        source: 'code_editor',
        actor: 'student',
        clientEventId: 'run-1',
        content: 'function twoSum() {}',
        payload: expect.objectContaining({ passed: 1, failed: 1, total: 2, status: 'failed', language: 'javascript' }),
      })
    );
    expect(run).toMatchObject({
      id: 'tr1',
      trigger: 'student',
      status: 'failed',
      passed: 1,
      failed: 1,
      total: 2,
      code: 'function twoSum() {}',
      clientRunId: 'run-1',
      reportedToLeiaAt: null,
    });
    expect(run.createdAt).toEqual(new Date('2026-11-13T10:00:00.000Z'));
  });

  test('un error de la suite marca la ejecución como error', async () => {
    const { run } = await TestRunService.record('s1', { ...payload, results: [], error: 'SyntaxError: Unexpected token' });

    expect(run).toMatchObject({ status: 'error', total: 0, error: 'SyntaxError: Unexpected token' });
  });

  test('avisa al dashboard sin incluir el código', async () => {
    EventRepository.countsByTypeForSession.mockResolvedValue({ test_run: 4 });

    await TestRunService.record('s1', payload);

    const legacy = emitToReplication.mock.calls.find(([, event]) => event === 'session:testRun');
    expect(legacy[0]).toBe('rep1');
    expect(legacy[2].sessionId).toBe('s1');
    expect(legacy[2].testRunCount).toBe(5);
    expect(legacy[2].testRun).not.toHaveProperty('code');
    expect(legacy[2].testRun.status).toBe('failed');
    expect(JSON.stringify(emitToReplication.mock.calls)).not.toContain('function twoSum');
  });

  test('guarda pero no emite para sesiones de prueba', async () => {
    SessionRepository.findById.mockResolvedValue({ ...session, isTest: true });

    const { created } = await TestRunService.record('s1', payload);

    expect(created).toBe(true);
    expect(emitToReplication).not.toHaveBeenCalled();
  });

  test('un clientRunId repetido devuelve la ejecución existente sin duplicar', async () => {
    EventRepository.findByClientEventIds.mockResolvedValue([{ clientEventId: 'run-1', id: 'e1', at: new Date() }]);
    EventRepository.findBySessionAndClientEventId.mockResolvedValue(runEvent({ content: 'stored code' }));

    const result = await TestRunService.record('s1', payload);

    expect(result.created).toBe(false);
    expect(result.run).toMatchObject({ id: 'e1', code: 'stored code', status: 'failed' });
    expect(EventRepository.findBySessionAndClientEventId).toHaveBeenCalledWith('s1', 'run-1', { withContent: true });
    expect(EventRepository.create).not.toHaveBeenCalled();
    expect(emitToReplication).not.toHaveBeenCalled();
  });

  test('una carrera entre dos envíos iguales se resuelve con la ejecución ya guardada', async () => {
    EventRepository.create.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 }));
    EventRepository.findBySessionAndClientEventId.mockResolvedValue(runEvent());

    await expect(TestRunService.record('s1', payload)).resolves.toMatchObject({ created: false, run: { id: 'e1' } });
  });

  test('rechaza una sesión inexistente', async () => {
    SessionRepository.findById.mockResolvedValue(null);
    await expect(TestRunService.record('nope', payload)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('rechaza una sesión ya terminada, aunque la ejecución sea anterior al final', async () => {
    SessionRepository.findById.mockResolvedValue({ ...session, finishedAt: new Date() });
    await expect(
      TestRunService.record('s1', { ...payload, clientRunAt: new Date(Date.now() - 60000) })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(EventRepository.create).not.toHaveBeenCalled();
  });

  test('rechaza mientras el consentimiento de uso de datos está pendiente', async () => {
    SessionRepository.findById.mockResolvedValue({
      ...session,
      dataUsage: { config: { dataUsageConsentRequired: true }, consentStatus: 'pending' },
    });
    await expect(TestRunService.record('s1', payload)).rejects.toMatchObject({ statusCode: 403 });
  });

  test('rechaza actividades sin editor de código', async () => {
    ReplicationRepository.findLeia.mockResolvedValue({ leia: { spec: { problem: { spec: { widgets: [] } } } } });
    await expect(TestRunService.record('s1', payload)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('rechaza al superar el tope de ejecuciones por sesión', async () => {
    EventRepository.countsByTypeForSession.mockResolvedValue({ test_run: 300 });
    await expect(TestRunService.record('s1', payload)).rejects.toMatchObject({ statusCode: 429 });
    expect(EventRepository.create).not.toHaveBeenCalled();
  });

  test('rechaza un informe inválido', async () => {
    await expect(TestRunService.record('s1', { ...payload, language: 'text' })).rejects.toMatchObject({ statusCode: 400 });
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
  const events = [
    runEvent({ id: 'a', session: 's1' }),
    runEvent({ id: 'b', session: 's2', payload: { ...runEvent().payload, status: 'passed' } }),
    runEvent({ id: 'c', session: 's1', actor: 'leia' }),
  ];

  test('attachSummaries añade las ejecuciones de cada sesión, sin código', async () => {
    EventRepository.findByReplication.mockResolvedValue(events.map((event) => ({ ...event, content: 'secret' })));
    const sessions = [{ toJSON: () => ({ id: 's1', messages: [] }) }, { id: 's3', messages: [] }];

    const result = await TestRunService.attachSummaries('rep1', sessions);

    expect(EventRepository.findByReplication).toHaveBeenCalledWith('rep1', { type: 'test_run' });
    expect(result[0].testRuns.map((run) => [run.id, run.trigger])).toEqual([
      ['a', 'student'],
      ['c', 'leia'],
    ]);
    expect(result[0].testRuns[0]).not.toHaveProperty('code');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result[1].testRuns).toEqual([]);
  });

  test('liveSummariesBySession devuelve el total y solo las últimas ejecuciones', async () => {
    EventRepository.findByReplication.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => runEvent({ id: `r${index}`, session: 's1' }))
    );

    const live = await TestRunService.liveSummariesBySession('rep1');

    expect(live.get('s1').testRunCount).toBe(8);
    expect(live.get('s1').testRuns.map((run) => run.id)).toEqual(['r3', 'r4', 'r5', 'r6', 'r7']);
  });

  test('findForSession filtra por sesión y replicación y trae el código', async () => {
    EventRepository.findBySession.mockResolvedValue([runEvent({ content: 'function twoSum() {}' })]);

    const runs = await TestRunService.findForSession('rep1', 's1');

    expect(EventRepository.findBySession).toHaveBeenCalledWith('s1', 'rep1', { type: 'test_run', withContent: true });
    expect(runs[0].code).toBe('function twoSum() {}');
  });
});

describe('getReplicationCSV — una fila por ejecución', () => {
  test('cabecera, actividad y stage, numeración, escapado y sesiones excluidas', async () => {
    ReplicationRepository.findById.mockResolvedValue({ experiment: { stages: [{ id: 'st1' }, { id: 'st2' }] } });
    SessionRepository.findByReplicationWithUser.mockResolvedValue([
      { id: 's1', run: 'run1', stageIndex: 0, user: { email: 'ana@example.com' } },
      { id: 's2', user: null },
      { id: 's3', user: { email: 'declined@example.com' }, dataUsage: { consentStatus: 'declined' } },
    ]);
    EventRepository.findByReplication.mockResolvedValue([
      runEvent({
        id: 'tr1',
        reportedToLeiaAt: new Date('2026-11-13T10:05:00.000Z'),
        content: 'function twoSum(a, b) {\n  return "x";\n}',
      }),
      runEvent({
        id: 'tr2',
        actor: 'leia',
        createdAt: new Date('2026-11-13T10:10:00.000Z'),
        contentTruncated: true,
        content: 'x'.repeat(5),
        payload: { language: 'javascript', fnName: 'twoSum', status: 'error', passed: 0, failed: 0, total: 0, durationMs: 3, error: 'SyntaxError', results: [] },
      }),
      // Sesión que rechazó el uso de datos y sesión de prueba (no está en la lista).
      runEvent({ id: 'tr3', session: 's3', content: 'declined code' }),
      runEvent({ id: 'tr4', session: 'test-session', content: 'test session code' }),
    ]);

    const csv = await TestRunService.getReplicationCSV('rep1');
    const [header] = csv.split('\n');

    expect(EventRepository.findByReplication).toHaveBeenCalledWith('rep1', { type: 'test_run', withContent: true });
    expect(header).toBe(TEST_RUNS_CSV_HEADER.join(','));
    expect(header).toBe(
      'Session ID,Run ID,Stage,User,Test Run ID,Run Number,Timestamp,Trigger,Language,Function,Status,Passed,Failed,Total,Duration Ms,Error,Failed Tests,Results JSON,Reported To LEIA At,Code Truncated,Code'
    );

    expect(csv).toContain(
      's1,run1,1/2,ana@example.com,tr1,1,2026-11-13T10:00:00.000Z,student,javascript,twoSum,failed,1,1,2,12,,"with ""quotes"", commas",'
    );
    // El código multilínea va entre comillas con las comillas internas dobladas.
    expect(csv).toContain(',FALSE,"function twoSum(a, b) {\n  return ""x"";\n}"\n');
    // Segunda ejecución de la misma sesión: número 2.
    expect(csv).toContain('s1,run1,1/2,ana@example.com,tr2,2,2026-11-13T10:10:00.000Z,leia,javascript,twoSum,error,0,0,0,3,SyntaxError,,[],,TRUE,xxxxx\n');
    expect(csv).not.toContain('tr3');
    expect(csv).not.toContain('declined code');
    expect(csv).not.toContain('tr4');
  });

  test('sin ejecuciones devuelve solo la cabecera', async () => {
    SessionRepository.findByReplicationWithUser.mockResolvedValue([{ id: 's1', user: null }]);
    EventRepository.findByReplication.mockResolvedValue([]);

    const csv = await TestRunService.getReplicationCSV('rep1');

    expect(csv).toBe(`${TEST_RUNS_CSV_HEADER.join(',')}\n`);
  });
});

describe('pendingNote / markReported — aviso al LEIA', () => {
  test('sin ejecuciones pendientes no hay nota', async () => {
    EventRepository.findUnreported.mockResolvedValue([]);
    await expect(TestRunService.pendingNote('s1')).resolves.toBeNull();
    expect(EventRepository.findUnreported).toHaveBeenCalledWith('s1', { type: 'test_run', actor: 'student' }, 20);
  });

  test('devuelve el contexto y la fecha de recepción de la última ejecución descrita', async () => {
    const latest = new Date('2026-11-13T10:02:00.000Z');
    EventRepository.findUnreported.mockResolvedValue([
      runEvent({ id: 'a', createdAt: new Date('2026-11-13T10:00:00Z'), payload: { status: 'failed', passed: 0, total: 2, results: [], language: 'python' } }),
      runEvent({ id: 'b', createdAt: latest, payload: { status: 'passed', passed: 2, total: 2, results: [], language: 'python' } }),
    ]);

    const note = await TestRunService.pendingNote('s1', new Date('2026-11-13T10:05:00.000Z'));

    expect(note.upTo).toEqual(latest);
    expect(note.context).toContain('2 times');
    expect(note.context).toContain('All 2 tests passed.');
    expect(EventRepository.countUnreported).not.toHaveBeenCalled();
  });

  test('markReported sella solo las ejecuciones del estudiante hasta la fecha indicada', async () => {
    const upTo = new Date();
    await TestRunService.markReported('s1', upTo);
    expect(EventRepository.markReported).toHaveBeenCalledWith('s1', { type: 'test_run', actor: 'student' }, upTo);
  });
});
