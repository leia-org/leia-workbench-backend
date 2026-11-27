import { describe, expect, test, vi } from 'vitest';
import { eventBatchValidator, validateEvent } from '../src/validators/v1/eventValidator.js';
import {
  EVENT_TYPES,
  MAX_BATCH_EVENTS,
  MAX_CONTENT_LENGTH,
  deriveOutcome,
  getEventType,
  hasCodeEditorWidget,
} from '../src/utils/eventTypes.js';
import { isInteractionEventsEnabled, requireInteractionEvents } from '../src/config/features.js';

const base = (overrides = {}) => ({
  clientEventId: 'evt-1',
  type: 'clipboard_copy',
  source: 'code_editor',
  clientAt: '2026-11-26T10:00:00.000Z',
  ...overrides,
});

describe('registro de tipos de evento', () => {
  test('cubre los eventos de test, portapapeles y presencia', () => {
    expect(EVENT_TYPES).toEqual([
      'test_run',
      'clipboard_copy',
      'clipboard_cut',
      'clipboard_paste',
      'page_leave',
      'page_return',
    ]);
    expect(getEventType('test_run').consent).toBe('functional');
    expect(getEventType('clipboard_paste').consent).toBe('observational');
    expect(getEventType('toString')).toBeNull();
    expect(getEventType('nope')).toBeNull();
  });

  test('conserva los helpers de test runs', () => {
    expect(hasCodeEditorWidget({ leia: { spec: { problem: { spec: { widgets: [{ widgetType: 'codeEditor' }] } } } } })).toBe(true);
    expect(hasCodeEditorWidget({ runnerConfiguration: { lukeConfig: { widgets: [{ widgetType: 'codeEditor' }] } } })).toBe(true);
    expect(hasCodeEditorWidget(null)).toBe(false);
    expect(deriveOutcome([{ ok: true }, { ok: false }], null)).toEqual({ passed: 1, failed: 1, total: 2, status: 'failed' });
    expect(deriveOutcome([], 'timeout')).toMatchObject({ status: 'error' });
  });
});

describe('validateEvent — sobre común', () => {
  test('acepta un evento mínimo y rellena los valores por defecto', () => {
    const { event } = validateEvent(base({ content: 'abc', unknownField: 1 }));

    expect(event).toMatchObject({
      clientEventId: 'evt-1',
      type: 'clipboard_copy',
      source: 'code_editor',
      actor: 'student',
      seq: 0,
      content: 'abc',
      contentTruncated: false,
    });
    expect(event.clientAt).toBeInstanceOf(Date);
    expect(event).not.toHaveProperty('unknownField');
  });

  test.each([
    ['sin id de cliente', { clientEventId: undefined }],
    ['sin hora de cliente', { clientAt: undefined }],
    ['hora inválida', { clientAt: 'yesterday' }],
    ['superficie desconocida', { source: 'terminal' }],
    ['actor desconocido', { actor: 'teacher' }],
    ['superficie que no corresponde al tipo', { source: 'page' }],
    ['actor que no corresponde al tipo', { actor: 'leia' }],
    ['payload con un valor fuera de lista', { payload: { method: 'telepathy' } }],
  ])('rechaza %s', (_label, override) => {
    const result = validateEvent(base(override));
    expect(result.rejected.reason).toBe('validation');
    expect(result.event).toBeUndefined();
  });

  test('distingue un tipo desconocido', () => {
    expect(validateEvent(base({ type: 'keystroke' })).rejected).toEqual({ reason: 'unknown_type' });
  });

  test('el mensaje de rechazo no incluye el contenido', () => {
    const result = validateEvent(base({ source: 'page', content: 'secret pasted text' }));
    expect(JSON.stringify(result)).not.toContain('secret pasted text');
  });
});

describe('validateEvent — por tipo', () => {
  test('portapapeles: deriva longitud, líneas, hash y vista previa', () => {
    const { event } = validateEvent(
      base({ type: 'clipboard_cut', content: 'a\r\nb\rc', payload: { method: 'menu', wholeLine: true, clipboardTypes: ['text/plain'] } })
    );

    expect(event.payload).toMatchObject({ method: 'menu', wholeLine: true, length: 6, lines: 3, preview: 'a\nb\nc' });
    expect(event.payload.hash).toMatch(/^[0-9a-f]{64}$/);
    // Mismo texto con otros saltos de línea: mismo hash.
    expect(validateEvent(base({ content: 'a\nb\nc' })).event.payload.hash).toBe(event.payload.hash);
  });

  test('portapapeles: el texto es opcional y la longitud original se respeta', () => {
    const empty = validateEvent(base()).event;
    expect(empty.content).toBeUndefined();
    expect(empty.payload).toMatchObject({ method: 'unknown', length: 0, lines: 0, preview: '' });

    const long = 'x'.repeat(MAX_CONTENT_LENGTH + 10);
    const cut = validateEvent(base({ content: long, payload: { length: long.length } })).event;
    expect(cut.content).toHaveLength(MAX_CONTENT_LENGTH);
    expect(cut.contentTruncated).toBe(true);
    expect(cut.payload.length).toBe(MAX_CONTENT_LENGTH + 10);
  });

  test('pegado: origen y copia con la que coincide', () => {
    const { event } = validateEvent(
      base({
        type: 'clipboard_paste',
        source: 'chat_input',
        content: 'x',
        payload: {
          method: 'drop',
          origin: 'internal',
          match: { clientEventId: 'copy-9', sessionId: 's0', source: 'notes', kind: 'trimmed', ageMs: 1200 },
        },
      })
    );
    expect(event.payload).toMatchObject({ method: 'drop', origin: 'internal', match: { clientEventId: 'copy-9', source: 'notes' } });

    expect(validateEvent(base({ type: 'clipboard_paste', content: 'x' })).event.payload.origin).toBe('unknown');
    expect(validateEvent(base({ type: 'clipboard_copy', payload: { method: 'drop' } })).event.payload.method).toBe('drop');
  });

  test('test run: exige código y resultados o error, y calcula el resultado', () => {
    const run = base({
      type: 'test_run',
      actor: 'leia',
      content: 'function f() {}',
      payload: { language: 'python', results: [{ name: 't', ok: true }], passed: 50, status: 'failed' },
    });
    const { event } = validateEvent(run);
    expect(event.payload).toEqual({
      language: 'python',
      fnName: '',
      results: [{ name: 't', ok: true }],
      error: null,
      durationMs: 0,
      passed: 1,
      failed: 0,
      total: 1,
      status: 'passed',
    });

    expect(validateEvent({ ...run, content: undefined }).rejected.reason).toBe('validation');
    expect(validateEvent({ ...run, source: 'chat_input' }).rejected.reason).toBe('validation');
    expect(validateEvent({ ...run, payload: { language: 'python', results: [] } }).rejected.reason).toBe('validation');
    expect(validateEvent({ ...run, payload: { language: 'text', results: [{ ok: true }] } }).rejected.reason).toBe('validation');
    expect(validateEvent({ ...run, content: '' }).event.content).toBe('');
  });

  test('presencia: sin contenido aunque el cliente lo envíe', () => {
    const leave = validateEvent(base({ type: 'page_leave', source: 'page', payload: { reason: 'blur' }, content: 'ignored' }));
    expect(leave.event.content).toBeUndefined();
    expect(leave.event.payload).toEqual({ reason: 'blur' });

    const back = validateEvent(
      base({ type: 'page_return', source: 'page', payload: { awayMs: 42000, reason: 'hidden', becameHidden: true } })
    );
    expect(back.event.payload).toEqual({ awayMs: 42000, reason: 'hidden', becameHidden: true });

    expect(validateEvent(base({ type: 'page_leave', source: 'page', payload: {} })).rejected.reason).toBe('validation');
    expect(validateEvent(base({ type: 'page_return', source: 'page', payload: { awayMs: -1 } })).rejected.reason).toBe('validation');
  });
});

describe('eventBatchValidator', () => {
  test('solo valida la forma del lote', async () => {
    const value = await eventBatchValidator.validateAsync(
      { sentAt: '2026-11-26T10:00:00.000Z', events: [{ anything: true }], extra: 1 },
      { stripUnknown: true }
    );
    expect(value.events).toEqual([{ anything: true }]);
    expect(value).not.toHaveProperty('extra');

    await expect(eventBatchValidator.validateAsync({ events: [] })).rejects.toMatchObject({ isJoi: true });
    await expect(eventBatchValidator.validateAsync({})).rejects.toMatchObject({ isJoi: true });
    await expect(
      eventBatchValidator.validateAsync({ events: Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => ({})) })
    ).rejects.toMatchObject({ isJoi: true });
  });
});

describe('flag de eventos de interacción', () => {
  const response = () => {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    return res;
  };

  test('solo se activa con el origen de pre y sin el de producción', () => {
    vi.stubEnv('FRONTEND_URL', 'https://pre.workbench.leia.ovh/, http://localhost:8080');
    expect(isInteractionEventsEnabled()).toBe(true);
    vi.stubEnv('FRONTEND_URL', 'https://pre.workbench.leia.ovh,https://workbench.leia.ovh');
    expect(isInteractionEventsEnabled()).toBe(false);
    vi.stubEnv('FRONTEND_URL', 'http://localhost:8080');
    expect(isInteractionEventsEnabled()).toBe(false);
    vi.unstubAllEnvs();
  });

  test('las rutas responden 404 cuando está desactivado', () => {
    vi.stubEnv('FRONTEND_URL', 'https://workbench.leia.ovh');
    const res = response();
    const next = vi.fn();
    requireInteractionEvents({}, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();

    vi.stubEnv('FRONTEND_URL', 'https://pre.workbench.leia.ovh');
    requireInteractionEvents({}, response(), next);
    expect(next).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});
