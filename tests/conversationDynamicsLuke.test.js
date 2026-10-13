import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
const { createServer, provider, dynamics } = vi.hoisted(() => ({
  createServer: vi.fn(), provider: { id: 'gemini', name: 'gemini', voices: [{ id: 'Puck' }, { id: 'Kore' }], connect: vi.fn() },
  dynamics: { open: vi.fn(), releaseOpening: vi.fn(), completeOpening: vi.fn(), observeSafely: vi.fn() },
}));
vi.mock('@leia-org/luke-server', () => ({ createLukeServer: createServer, gemini: () => provider }));
vi.mock('../src/providers/lukeOpenAI.js', () => ({ openai: () => ({
  ...provider, id: 'openai', name: 'openai',
  voices: ['alloy', 'ash', 'marin', 'cedar'].map((id) => ({ id, name: id })),
}) }));
vi.mock('../src/services/v1/ConversationDynamicsService.js', () => ({ default: dynamics, dynamicsInstructions: () => '' }));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({ default: {} }));
vi.mock('../src/services/v1/ReplicationService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/SessionService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/SupervisorService.js', () => ({ default: {} }));
vi.mock('../src/utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import LukeService from '../src/services/v1/LukeService.js';
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.clearAllMocks();
  dynamics.open.mockResolvedValue();
  dynamics.releaseOpening.mockResolvedValue();
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('GEMINI_API_KEY', 'test');
});
describe('Luke opening provider lifecycle', () => {
  test('opens only after the activity provider and voice are selected; releases an unfinished opening on disconnect', async () => {
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test';
    try {
      LukeService.initialize({});
      const options = createServer.mock.calls[0][0];
      const defaultConnection = { send: vi.fn() };
      const targetConnection = { send: vi.fn() };
      const targetSend = targetConnection.send;
      provider.connect.mockResolvedValueOnce(defaultConnection).mockResolvedValueOnce(targetConnection);
      const tracked = options.providers[0];
      await tracked.connect({ voice: 'Puck' });
      const userSession = { sessionId: 'session', leia: { runnerConfiguration: { lukeConfig: { provider: 'gemini', voice: 'Kore' } } } };
      const live = { id: 'live', userSession, providerConnection: defaultConnection };
      options.onConnect(live);
      expect(dynamics.open).not.toHaveBeenCalled();
      await tracked.connect({ voice: 'Kore' });
      live.providerConnection = targetConnection;
      options.onConnect(live);
      expect(dynamics.open).not.toHaveBeenCalled();
      const audio = { type: 'audio', data: new Uint8Array([0, 0]) };
      targetConnection.send(audio);
      expect(dynamics.open).toHaveBeenCalledWith('session', userSession.leia, expect.any(Function), true, 'live');
      await dynamics.open.mock.calls[0][2]('Opening instructions');
      expect(targetSend).toHaveBeenCalledWith({ type: 'text', content: 'Opening instructions' });
      targetConnection.send(audio);
      expect(dynamics.open).toHaveBeenCalledTimes(1);
      options.onDisconnect(live);
      expect(dynamics.releaseOpening).toHaveBeenCalledWith('session', 'live');
    } finally {
      if (original === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = original;
    }
  });

  test.each(['ash', 'marin', 'cedar'])('advertises and opens with the configured OpenAI voice %s', async (voice) => {
    vi.stubEnv('OPENAI_API_KEY', 'test');
    vi.stubEnv('GEMINI_API_KEY', '');
    LukeService.initialize({});
    const options = createServer.mock.calls[0][0];
    const tracked = options.providers[0];
    expect(tracked.voices).toContainEqual({ id: voice, name: voice });
    const send = vi.fn();
    provider.connect.mockResolvedValue({ send });
    const connection = await tracked.connect({ voice });
    const leia = { runnerConfiguration: { lukeConfig: { provider: 'openai', voice } } };
    options.onConnect({ id: 'live', userSession: { sessionId: 'session', leia }, providerConnection: connection });
    expect(dynamics.open).not.toHaveBeenCalled();
    connection.send({ type: 'audio', data: new Uint8Array([0, 0]) });
    await dynamics.open.mock.calls[0][2]('Hello');
    expect(send).toHaveBeenCalledWith({ type: 'text', content: 'Hello' });
  });
});
