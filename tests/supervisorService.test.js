import { describe, expect, test, beforeEach, vi } from 'vitest';

// Aislamos el supervisor de la base de datos, del Runner y de los sockets.
vi.mock('../src/services/v1/SessionService.js', () => ({
  default: { findById: vi.fn(), appendSupervisorObservation: vi.fn() },
}));
vi.mock('../src/services/v1/MessageService.js', () => ({
  default: { findBySession: vi.fn() },
}));
vi.mock('../src/services/v1/RunnerService.js', () => ({
  default: { observeSupervisor: vi.fn() },
}));
vi.mock('../src/socket/index.js', () => ({
  emitToReplicationAdmins: vi.fn(),
}));
vi.mock('../src/utils/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import SessionService from '../src/services/v1/SessionService.js';
import MessageService from '../src/services/v1/MessageService.js';
import RunnerService from '../src/services/v1/RunnerService.js';
import logger from '../src/utils/logger.js';
import SupervisorService from '../src/services/v1/SupervisorService.js';

// LEIA con supervisor activo; cada test ajusta la clave del supervisor y la del runner.
function buildLeia({ supervisorKey = {}, runnerConfiguration = {} } = {}) {
  return {
    leia: { spec: { supervisorConfig: { enabled: true, instructions: 'Observa', ...supervisorKey } } },
    runnerConfiguration,
  };
}

function sentKey() {
  return RunnerService.observeSupervisor.mock.calls[0][0].runnerConfiguration;
}

beforeEach(() => {
  vi.clearAllMocks();
  SessionService.findById.mockResolvedValue({ _id: 's1', replication: 'rep1', supervisorState: {} });
  MessageService.findBySession.mockResolvedValue([{ isLeia: false, text: 'Hola' }]);
  RunnerService.observeSupervisor.mockResolvedValue({ flags: [], nudge: null });
  SessionService.appendSupervisorObservation.mockResolvedValue();
});

describe('SupervisorService.observe — clave BYOK del supervisor', () => {
  test('usa la clave propia del supervisor cuando la tiene', async () => {
    const leia = buildLeia({
      supervisorKey: { apiKeyId: 'sup-key', apiKeyRequesterId: 'sup-user' },
      runnerConfiguration: { provider: 'alma', apiKeyId: 'alma-key', apiKeyRequesterId: 'leia-user' },
    });

    await SupervisorService.observe('s1', leia);

    expect(sentKey()).toEqual({ apiKeyId: 'sup-key', apiKeyRequesterId: 'sup-user' });
  });

  test('recurre a la clave de la LEIA cuando es de OpenAI', async () => {
    const leia = buildLeia({
      runnerConfiguration: { provider: 'openai-responses', apiKeyId: 'openai-key', apiKeyRequesterId: 'leia-user' },
    });

    await SupervisorService.observe('s1', leia);

    expect(sentKey()).toEqual({ apiKeyId: 'openai-key', apiKeyRequesterId: 'leia-user' });
  });

  test.each(['alma', 'gemini-3.1-flash-lite-preview', 'ollama'])(
    'no llama al Runner si la LEIA usa %s y el supervisor no tiene clave propia',
    async (provider) => {
      const leia = buildLeia({
        runnerConfiguration: { provider, apiKeyId: 'other-key', apiKeyRequesterId: 'leia-user' },
      });

      await SupervisorService.observe('s1', leia);

      expect(RunnerService.observeSupervisor).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(provider));
    }
  );

  test('no mezcla el apiKeyId del supervisor con el apiKeyRequesterId de la LEIA', async () => {
    const leia = buildLeia({
      supervisorKey: { apiKeyId: 'sup-key' },
      runnerConfiguration: { provider: 'alma', apiKeyId: 'alma-key', apiKeyRequesterId: 'leia-user' },
    });

    await SupervisorService.observe('s1', leia);

    expect(RunnerService.observeSupervisor).not.toHaveBeenCalled();
  });
});
