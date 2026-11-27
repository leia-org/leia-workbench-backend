import { describe, expect, test, beforeEach, vi } from 'vitest';

// Aislamos el servicio de la base de datos y de los sockets.
vi.mock('../src/repositories/v1/EventRepository.js', () => ({
  default: {
    findByClientEventIds: vi.fn(),
    findBySessionAndClientEventId: vi.fn(),
    countsByTypeForSession: vi.fn(),
    countsByReplication: vi.fn(),
    findBySession: vi.fn(),
    findOneWithContent: vi.fn(),
    findByReplication: vi.fn(),
    create: vi.fn(),
    deleteBySession: vi.fn(),
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
import EventService, { EVENTS_CSV_HEADER, toSummary } from '../src/services/v1/EventService.js';
import { MAX_CONTENT_LENGTH, MAX_EVENTS_PER_SESSION } from '../src/utils/eventTypes.js';

const codeEditorLeia = { leia: { spec: { problem: { spec: { widgets: [{ widgetType: 'codeEditor' }] } } } } };

const startedAt = new Date('2026-11-26T10:00:00.000Z');
const now = new Date('2026-11-26T10:30:00.000Z');
const session = { id: 's1', replication: 'rep1', leia: 'leia1', isTest: false, startedAt };

const consent = (consentStatus) => ({
  config: { dataUsageConsentRequired: true, conversationAutomatedRemoval: true },
  consentStatus,
});

let nextId;
const paste = (overrides = {}) => ({
  clientEventId: `paste-${nextId++}`,
  type: 'clipboard_paste',
  source: 'chat_input',
  clientAt: '2026-11-26T10:29:50.000Z',
  seq: 1,
  payload: { method: 'keyboard', origin: 'external' },
  content: 'line one\r\nline two',
  ...overrides,
});
const testRun = (overrides = {}) => ({
  clientEventId: `run-${nextId++}`,
  type: 'test_run',
  source: 'code_editor',
  actor: 'student',
  clientAt: '2026-11-26T10:29:55.000Z',
  payload: {
    language: 'javascript',
    fnName: 'twoSum',
    results: [
      { name: 't1', ok: true },
      { name: 't2', ok: false, expected: '[0,1]', actual: 'undefined' },
    ],
    durationMs: 12,
  },
  content: 'function twoSum() {}',
  ...overrides,
});
const record = (events, options = {}) =>
  EventService.recordBatch('s1', { sentAt: '2026-11-26T10:30:00.000Z', events }, { now, ...options });

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 1;
  SessionRepository.findById.mockResolvedValue(session);
  ReplicationRepository.findLeia.mockResolvedValue(codeEditorLeia);
  EventRepository.countsByTypeForSession.mockResolvedValue({});
  EventRepository.findByClientEventIds.mockResolvedValue([]);
  let created = 0;
  EventRepository.create.mockImplementation(async (data) => ({ ...data, id: `e${++created}`, createdAt: now }));
});

describe('recordBatch — guardado de un lote de eventos', () => {
  test('guarda un pegado con los datos derivados y avisa al dashboard sin el texto', async () => {
    const { results } = await record([paste()]);

    expect(results).toEqual([{ clientEventId: 'paste-1', status: 'stored', id: 'e1', at: expect.any(Date) }]);
    expect(EventRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        session: 's1',
        replication: 'rep1',
        type: 'clipboard_paste',
        source: 'chat_input',
        actor: 'student',
        content: 'line one\r\nline two',
        hasContent: true,
        contentTruncated: false,
        payload: expect.objectContaining({
          method: 'keyboard',
          origin: 'external',
          length: 18,
          lines: 2,
          preview: 'line one\nline two',
          hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      })
    );

    expect(emitToReplication).toHaveBeenCalledTimes(1);
    const [replicationId, event, data] = emitToReplication.mock.calls[0];
    expect(replicationId).toBe('rep1');
    expect(event).toBe('session:events');
    expect(data.sessionId).toBe('s1');
    expect(data.counts).toEqual({ clipboard_paste: 1 });
    expect(data.events).toHaveLength(1);
    expect(data.events[0]).not.toHaveProperty('content');
    expect(JSON.stringify(data)).not.toContain('line one\\r\\nline two');
  });

  test('copia en el evento la posición de la sesión en la actividad', async () => {
    SessionRepository.findById.mockResolvedValue({ ...session, run: 'run1', stageId: 'stage-2', stageIndex: 1 });

    await record([paste()]);

    expect(EventRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ run: 'run1', stageId: 'stage-2', stageIndex: 1 })
    );
  });

  test('sitúa el evento en el reloj del servidor aunque el lote llegue tarde o el reloj del cliente esté desfasado', async () => {
    // El cliente va una hora adelantado: el evento ocurrió 10 s antes de enviar el lote.
    await EventService.recordBatch(
      's1',
      { sentAt: '2026-11-26T11:30:00.000Z', events: [paste({ clientAt: '2026-11-26T11:29:50.000Z' })] },
      { now }
    );
    expect(EventRepository.create.mock.calls[0][0].at).toEqual(new Date('2026-11-26T10:29:50.000Z'));

    // Nunca en el futuro ni antes de que empezara la sesión.
    await record([paste({ clientAt: '2026-11-26T10:40:00.000Z' }), paste({ clientAt: '2026-11-26T09:00:00.000Z' })]);
    expect(EventRepository.create.mock.calls[1][0].at).toEqual(now);
    expect(EventRepository.create.mock.calls[2][0].at).toEqual(startedAt);
  });

  test('sin hora de envío usa la de recepción', async () => {
    await EventService.recordBatch('s1', { events: [paste()] }, { now });
    expect(EventRepository.create.mock.calls[0][0].at).toEqual(now);
  });

  test('un test run se guarda con el resultado calculado en el servidor y mantiene su aviso propio', async () => {
    const { results } = await record([testRun({ payload: { ...testRun().payload, passed: 99, status: 'passed' } })]);

    expect(results[0].status).toBe('stored');
    expect(EventRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'test_run',
        content: 'function twoSum() {}',
        payload: expect.objectContaining({ passed: 1, failed: 1, total: 2, status: 'failed' }),
      })
    );
    const events = emitToReplication.mock.calls.map(([, name]) => name);
    expect(events).toEqual(['session:events', 'session:testRun']);
    const legacy = emitToReplication.mock.calls[1][2];
    expect(legacy.testRunCount).toBe(1);
    expect(legacy.testRun).toMatchObject({ trigger: 'student', status: 'failed', passed: 1, total: 2 });
    expect(legacy.testRun).not.toHaveProperty('code');
  });

  test('un evento inválido se informa sin tumbar el resto del lote ni devolver su contenido', async () => {
    const { results } = await record([
      paste({ clientEventId: 'ok' }),
      paste({ clientEventId: 'bad-source', source: 'page' }),
      paste({ clientEventId: 'bad-type', type: 'keystroke' }),
      { type: 'clipboard_paste', content: 'secret pasted text' },
    ]);

    expect(results.map((result) => [result.clientEventId, result.status, result.reason])).toEqual([
      ['ok', 'stored', undefined],
      ['bad-source', 'rejected', 'validation'],
      ['bad-type', 'rejected', 'unknown_type'],
      [null, 'rejected', 'validation'],
    ]);
    expect(EventRepository.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(results)).not.toContain('secret pasted text');
  });

  test('recorta el contenido demasiado largo y lo marca, conservando la longitud original', async () => {
    const long = 'x'.repeat(MAX_CONTENT_LENGTH + 500);
    await record([paste({ content: long, payload: { method: 'keyboard', length: long.length } })]);

    const stored = EventRepository.create.mock.calls[0][0];
    expect(stored.content).toHaveLength(MAX_CONTENT_LENGTH);
    expect(stored.contentTruncated).toBe(true);
    expect(stored.payload.length).toBe(MAX_CONTENT_LENGTH + 500);
  });

  test('un evento ya guardado o repetido en el lote no se duplica', async () => {
    const at = new Date('2026-11-26T10:20:00.000Z');
    EventRepository.findByClientEventIds.mockResolvedValue([{ clientEventId: 'known', id: 'e0', at }]);

    const { results } = await record([
      paste({ clientEventId: 'known' }),
      paste({ clientEventId: 'twice' }),
      paste({ clientEventId: 'twice' }),
    ]);

    expect(results).toEqual([
      { clientEventId: 'known', status: 'duplicate', id: 'e0', at },
      expect.objectContaining({ clientEventId: 'twice', status: 'stored' }),
      { clientEventId: 'twice', status: 'duplicate' },
    ]);
    expect(EventRepository.create).toHaveBeenCalledTimes(1);
  });

  test('una carrera entre dos envíos iguales se resuelve como duplicado', async () => {
    EventRepository.create.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 }));

    const { results } = await record([paste({ clientEventId: 'raced' })]);

    expect(results).toEqual([{ clientEventId: 'raced', status: 'duplicate' }]);
    expect(emitToReplication).not.toHaveBeenCalled();
  });

  test('rechaza una sesión inexistente', async () => {
    SessionRepository.findById.mockResolvedValue(null);
    await expect(record([paste()])).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('recordBatch — consentimiento de uso de datos', () => {
  test('con el consentimiento pendiente no se acepta nada', async () => {
    SessionRepository.findById.mockResolvedValue({ ...session, dataUsage: consent('pending') });

    await expect(record([paste(), testRun()])).rejects.toMatchObject({ statusCode: 403 });
    expect(EventRepository.create).not.toHaveBeenCalled();
  });

  test('si el estudiante rechazó, solo se guarda lo que la actividad necesita', async () => {
    SessionRepository.findById.mockResolvedValue({ ...session, dataUsage: consent('declined') });

    const { results } = await record([
      paste({ clientEventId: 'p' }),
      { clientEventId: 'leave', type: 'page_leave', source: 'page', clientAt: now, payload: { reason: 'hidden' } },
      testRun({ clientEventId: 'r' }),
    ]);

    expect(results).toEqual([
      { clientEventId: 'p', status: 'skipped', reason: 'consent_declined' },
      { clientEventId: 'leave', status: 'skipped', reason: 'consent_declined' },
      expect.objectContaining({ clientEventId: 'r', status: 'stored' }),
    ]);
    expect(EventRepository.create).toHaveBeenCalledTimes(1);
  });

  test('si aceptó o no hace falta consentimiento, se guarda todo', async () => {
    SessionRepository.findById.mockResolvedValue({ ...session, dataUsage: consent('accepted') });
    expect((await record([paste()])).results[0].status).toBe('stored');

    SessionRepository.findById.mockResolvedValue({ ...session, dataUsage: undefined });
    expect((await record([paste()])).results[0].status).toBe('stored');
  });

  test('en una sesión de prueba no se observa al usuario ni se avisa al dashboard', async () => {
    SessionRepository.findById.mockResolvedValue({ ...session, isTest: true });

    const { results } = await record([paste({ clientEventId: 'p' }), testRun({ clientEventId: 'r' })]);

    expect(results).toEqual([
      { clientEventId: 'p', status: 'skipped', reason: 'test_session' },
      expect.objectContaining({ clientEventId: 'r', status: 'stored' }),
    ]);
    expect(emitToReplication).not.toHaveBeenCalled();
  });
});

describe('recordBatch — límites', () => {
  test('tras terminar la sesión solo entra la cola pendiente de antes del final, y por poco tiempo', async () => {
    const finishedAt = new Date('2026-11-26T10:29:55.000Z');
    SessionRepository.findById.mockResolvedValue({ ...session, finishedAt });

    const { results } = await record([
      paste({ clientEventId: 'before', clientAt: '2026-11-26T10:29:50.000Z' }),
      paste({ clientEventId: 'after', clientAt: '2026-11-26T10:29:58.000Z' }),
    ]);
    expect(results.map((result) => [result.clientEventId, result.status, result.reason])).toEqual([
      ['before', 'stored', undefined],
      ['after', 'rejected', 'session_finished'],
    ]);

    // Pasada la ventana de gracia ya no entra nada.
    const late = await EventService.recordBatch(
      's1',
      { sentAt: '2026-11-26T10:31:00.000Z', events: [paste({ clientAt: '2026-11-26T10:29:50.000Z' })] },
      { now: new Date('2026-11-26T10:31:00.000Z') }
    );
    expect(late.results[0]).toMatchObject({ status: 'rejected', reason: 'session_finished' });

    // Y sin ventana (ruta antigua de test runs), nada tras el final.
    const strict = await record([paste({ clientAt: '2026-11-26T10:29:50.000Z' })], { finishedGraceMs: 0 });
    expect(strict.results[0]).toMatchObject({ status: 'rejected', reason: 'session_finished' });
  });

  test('un test run solo aplica a actividades con editor de código', async () => {
    ReplicationRepository.findLeia.mockResolvedValue({ leia: { spec: { problem: { spec: { widgets: [] } } } } });

    const { results } = await record([testRun()]);

    expect(results[0]).toMatchObject({ status: 'rejected', reason: 'not_applicable' });
    expect(EventRepository.create).not.toHaveBeenCalled();
  });

  test('no carga la actividad si ningún evento la necesita', async () => {
    await record([paste()]);
    expect(ReplicationRepository.findLeia).not.toHaveBeenCalled();
  });

  test('respeta el tope por tipo y el tope global de la sesión', async () => {
    EventRepository.countsByTypeForSession.mockResolvedValue({ clipboard_paste: 299 });
    const perType = await record([paste({ clientEventId: 'last' }), paste({ clientEventId: 'over' })]);
    expect(perType.results.map((result) => [result.status, result.reason])).toEqual([
      ['stored', undefined],
      ['rejected', 'cap_reached'],
    ]);

    EventRepository.countsByTypeForSession.mockResolvedValue({ page_leave: 1000, page_return: 1000, test_run: 300, clipboard_copy: 300, clipboard_cut: 300, other: MAX_EVENTS_PER_SESSION });
    const global = await record([paste()]);
    expect(global.results[0]).toMatchObject({ status: 'rejected', reason: 'cap_reached' });
  });
});

describe('lecturas para el instructor', () => {
  test('toSummary nunca lleva el contenido', () => {
    expect(toSummary({ id: 'e1', content: 'secret', toJSON: () => ({ id: 'e1', content: 'secret', payload: {} }) })).toEqual({
      id: 'e1',
      payload: {},
    });
    expect(toSummary({ id: 'e1', content: 'secret' })).toEqual({ id: 'e1' });
  });

  test('attachCounts añade los contadores por tipo de cada sesión', async () => {
    EventRepository.countsByReplication.mockResolvedValue([
      { session: 's1', type: 'test_run', count: 3 },
      { session: 's1', type: 'clipboard_paste', count: 2 },
      { session: 's2', type: 'page_leave', count: 1 },
    ]);

    const result = await EventService.attachCounts('rep1', [
      { toJSON: () => ({ id: 's1', messages: [] }) },
      { id: 's3' },
    ]);

    expect(result[0].eventCounts).toEqual({ test_run: 3, clipboard_paste: 2 });
    expect(result[1].eventCounts).toEqual({});
  });

  test('findForSession filtra por sesión y replicación y devuelve resúmenes', async () => {
    EventRepository.findBySession.mockResolvedValue([{ id: 'e1', type: 'clipboard_copy', content: 'secret' }]);

    const events = await EventService.findForSession('rep1', 's1');

    expect(EventRepository.findBySession).toHaveBeenCalledWith('s1', 'rep1');
    expect(events).toEqual([{ id: 'e1', type: 'clipboard_copy' }]);
  });

  test('findOne devuelve el contenido de un evento de esa sesión y replicación, o 404', async () => {
    EventRepository.findOneWithContent.mockResolvedValue({ toJSON: () => ({ id: 'e1', content: 'pasted text' }) });
    await expect(EventService.findOne('rep1', 's1', 'e1')).resolves.toEqual({ id: 'e1', content: 'pasted text' });
    expect(EventRepository.findOneWithContent).toHaveBeenCalledWith('e1', 's1', 'rep1');

    EventRepository.findOneWithContent.mockResolvedValue(null);
    await expect(EventService.findOne('rep1', 's1', 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('getReplicationCSV — una fila por evento', () => {
  test('cabecera, stage, texto del portapapeles y sesiones excluidas', async () => {
    ReplicationRepository.findById.mockResolvedValue({ experiment: { stages: [{ id: 'st1' }, { id: 'st2' }] } });
    SessionRepository.findByReplicationWithUser.mockResolvedValue([
      { id: 's1', run: 'run1', stageId: 'st2', user: { email: 'ana@example.com' } },
      { id: 's2', user: null, dataUsage: { consentStatus: 'declined' } },
    ]);
    EventRepository.findByReplication.mockResolvedValue([
      {
        id: 'e1',
        session: 's1',
        type: 'clipboard_paste',
        source: 'code_editor',
        view: 'chat',
        actor: 'student',
        at: new Date('2026-11-26T10:00:05.000Z'),
        createdAt: new Date('2026-11-26T10:00:07.000Z'),
        clientAt: new Date('2026-11-26T11:00:05.000Z'),
        hasContent: true,
        contentTruncated: false,
        content: 'const a = "x";\nreturn a, 1;',
        payload: {
          method: 'keyboard',
          origin: 'internal',
          match: { clientEventId: 'copy-1', source: 'chat_input' },
          length: 27,
          lines: 2,
          hash: 'abc123',
          preview: 'const a',
        },
      },
      {
        id: 'e2',
        session: 's1',
        type: 'page_return',
        source: 'page',
        actor: 'student',
        at: new Date('2026-11-26T10:01:00.000Z'),
        createdAt: new Date('2026-11-26T10:01:01.000Z'),
        clientAt: new Date('2026-11-26T11:01:00.000Z'),
        payload: { awayMs: 42000, reason: 'hidden', becameHidden: true },
      },
      {
        id: 'e3',
        session: 's1',
        type: 'test_run',
        source: 'code_editor',
        actor: 'leia',
        at: new Date('2026-11-26T10:02:00.000Z'),
        createdAt: new Date('2026-11-26T10:02:00.000Z'),
        clientAt: new Date('2026-11-26T11:02:00.000Z'),
        hasContent: true,
        content: 'function hidden() {}',
        reportedToLeiaAt: null,
        payload: { status: 'failed', passed: 1, failed: 1, total: 2, durationMs: 12, results: [] },
      },
      // Sesión que rechazó el uso de datos y sesión de prueba (no está en la lista).
      { id: 'e4', session: 's2', type: 'test_run', source: 'code_editor', actor: 'student', payload: {} },
      { id: 'e5', session: 'test-session', type: 'clipboard_copy', source: 'notes', actor: 'student', payload: {} },
    ]);

    const csv = await EventService.getReplicationCSV('rep1');
    const [header] = csv.split('\n');

    expect(EventRepository.findByReplication).toHaveBeenCalledWith('rep1', { withContent: true });
    expect(header).toBe(EVENTS_CSV_HEADER.join(','));
    expect(header).toBe(
      'Session ID,Run ID,Stage,User,Event ID,Event Number,Timestamp,Received At,Client Timestamp,Type,Source,View,Actor,Method,Origin,Matched Event ID,Matched Source,Length,Lines,Truncated,Hash,Away Ms,Reason,Status,Passed,Failed,Total,Duration Ms,Reported To LEIA At,Text,Payload JSON'
    );
    expect(csv).toContain(
      's1,run1,2/2,ana@example.com,e1,1,2026-11-26T10:00:05.000Z,2026-11-26T10:00:07.000Z,2026-11-26T11:00:05.000Z,clipboard_paste,code_editor,chat,student,keyboard,internal,copy-1,chat_input,27,2,FALSE,abc123,,,,,,,,,"const a = ""x"";\nreturn a, 1;",'
    );
    expect(csv).toContain('s1,run1,2/2,ana@example.com,e2,2,2026-11-26T10:01:00.000Z,');
    expect(csv).toContain(',page_return,page,,student,,,,,,,,,42000,hidden,,,,,,,,');
    // El código de un test run no va en este fichero.
    expect(csv).toContain(',test_run,code_editor,,leia,,,,,,,FALSE,,,,failed,1,1,2,12,,,');
    expect(csv).not.toContain('function hidden');
    expect(csv).not.toContain('e4');
    expect(csv).not.toContain('e5');
  });

  test('sin eventos devuelve solo la cabecera', async () => {
    ReplicationRepository.findById.mockResolvedValue({ experiment: {} });
    SessionRepository.findByReplicationWithUser.mockResolvedValue([{ id: 's1', user: null }]);
    EventRepository.findByReplication.mockResolvedValue([]);

    await expect(EventService.getReplicationCSV('rep1')).resolves.toBe(`${EVENTS_CSV_HEADER.join(',')}\n`);
  });
});
