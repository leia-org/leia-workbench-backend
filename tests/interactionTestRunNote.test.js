import { beforeEach, describe, expect, test, vi } from 'vitest';

// Aislamos sendSessionMessage de la base de datos, del Runner y de los servicios laterales.
vi.mock('../src/models/Session.js', () => ({ default: {} }));
vi.mock('../src/services/v1/SessionService.js', () => ({
  default: { findById: vi.fn(), addMessage: vi.fn(), clearPendingNudge: vi.fn() },
}));
vi.mock('../src/services/v1/ReplicationService.js', () => ({ default: { findLeia: vi.fn() } }));
vi.mock('../src/services/v1/RunnerService.js', () => ({
  default: { sendMessage: vi.fn(), sendMultiLeiaMessage: vi.fn() },
}));
vi.mock('../src/services/v1/UserService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: { create: vi.fn() } }));
vi.mock('../src/services/v1/SupervisorService.js', () => ({ default: { observeAsync: vi.fn() } }));
vi.mock('../src/services/v1/SpectatorService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/ConversationDynamicsService.js', () => ({
  default: { observeSafely: vi.fn() },
  publicDynamicsState: () => ({ leiaSpeaksFirst: { enabled: false, completed: true } }),
}));
vi.mock('../src/services/v1/TestRunService.js', () => ({
  default: { pendingNote: vi.fn(), markReported: vi.fn() },
  hasCodeEditorWidget: (leia) =>
    Boolean(leia?.leia?.spec?.problem?.spec?.widgets?.some((widget) => widget.widgetType === 'codeEditor')),
}));
vi.mock('../src/utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import InteractionService from '../src/services/v1/InteractionService.js';
import SessionService from '../src/services/v1/SessionService.js';
import ReplicationService from '../src/services/v1/ReplicationService.js';
import RunnerService from '../src/services/v1/RunnerService.js';
import MessageService from '../src/services/v1/MessageService.js';
import TestRunService from '../src/services/v1/TestRunService.js';

const session = { id: 'session', replication: 'replication', leia: 'leia', interactionMode: 'single' };
const codeEditorLeia = { leia: { spec: { problem: { spec: { widgets: [{ widgetType: 'codeEditor' }] } } } } };
const plainLeia = { leia: { spec: { problem: { spec: {} } } } };
const upTo = new Date('2026-11-13T10:00:00.000Z');
const note = { context: '[Automatic context from the code editor.]', upTo };

beforeEach(() => {
  vi.clearAllMocks();
  SessionService.findById.mockResolvedValue(session);
  SessionService.addMessage.mockResolvedValue(session);
  ReplicationService.findLeia.mockResolvedValue(codeEditorLeia);
  MessageService.create.mockImplementation(async (text, isLeia) => ({ id: isLeia ? 'leia-msg' : 'user-msg', text }));
  RunnerService.sendMessage.mockResolvedValue({ message: 'Reply', contextApplied: true });
  TestRunService.pendingNote.mockResolvedValue(note);
});

describe('sendSessionMessage — aviso al LEIA de tests ejecutados por el estudiante', () => {
  test('envía la nota como contexto aparte y guarda el mensaje del estudiante intacto', async () => {
    await InteractionService.sendSessionMessage('session', 'hi', { tools: [] });

    expect(MessageService.create).toHaveBeenCalledWith('hi', false, 'session');
    expect(RunnerService.sendMessage).toHaveBeenCalledWith(
      'session',
      'hi',
      expect.objectContaining({ context: note.context })
    );
    expect(TestRunService.markReported).toHaveBeenCalledWith('session', upTo);
  });

  test('sella también cuando el Runner responde con llamadas a tools', async () => {
    RunnerService.sendMessage.mockResolvedValue({
      toolCalls: [{ callId: 'c1', name: 'codeEditor_read', arguments: '{}' }],
      contextApplied: true,
    });

    const result = await InteractionService.sendSessionMessage('session', 'hi', {});

    expect(result.toolCalls).toHaveLength(1);
    expect(TestRunService.markReported).toHaveBeenCalledWith('session', upTo);
  });

  test('sin acuse del Runner las ejecuciones quedan pendientes', async () => {
    RunnerService.sendMessage.mockResolvedValue({ message: 'Reply' });

    await InteractionService.sendSessionMessage('session', 'hi', {});

    expect(TestRunService.markReported).not.toHaveBeenCalled();
  });

  test('si el Runner falla las ejecuciones quedan pendientes', async () => {
    RunnerService.sendMessage.mockRejectedValue(new Error('runner down'));

    await expect(InteractionService.sendSessionMessage('session', 'hi', {})).rejects.toThrow('runner down');
    expect(TestRunService.markReported).not.toHaveBeenCalled();
  });

  test('sin ejecuciones pendientes no se envía contexto', async () => {
    TestRunService.pendingNote.mockResolvedValue(null);

    await InteractionService.sendSessionMessage('session', 'hi', {});

    expect(RunnerService.sendMessage.mock.calls[0][2].context).toBeUndefined();
    expect(TestRunService.markReported).not.toHaveBeenCalled();
  });

  test('no busca ejecuciones en la continuación de un tool', async () => {
    await InteractionService.sendSessionMessage('session', undefined, {
      toolResults: [{ callId: 'c1', output: {} }],
    });

    expect(TestRunService.pendingNote).not.toHaveBeenCalled();
    expect(RunnerService.sendMessage.mock.calls[0][2].context).toBeUndefined();
  });

  test('no busca ejecuciones si la actividad no tiene editor de código', async () => {
    ReplicationService.findLeia.mockResolvedValue(plainLeia);

    await InteractionService.sendSessionMessage('session', 'hi', {});

    expect(TestRunService.pendingNote).not.toHaveBeenCalled();
  });

  test('no busca ejecuciones en sesiones MultiLEIA', async () => {
    SessionService.findById.mockResolvedValue({ ...session, interactionMode: 'multi', leias: [] });
    RunnerService.sendMultiLeiaMessage.mockResolvedValue({ messages: [] });

    await InteractionService.sendSessionMessage('session', 'hi', {});

    expect(TestRunService.pendingNote).not.toHaveBeenCalled();
  });

  test('un fallo al buscar ejecuciones no rompe el turno', async () => {
    TestRunService.pendingNote.mockRejectedValue(new Error('db down'));

    const result = await InteractionService.sendSessionMessage('session', 'hi', {});

    expect(result.message).toBe('Reply');
    expect(RunnerService.sendMessage.mock.calls[0][2].context).toBeUndefined();
  });
});
