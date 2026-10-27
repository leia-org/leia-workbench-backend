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
vi.mock('../src/services/v1/ConversationDynamicsService.js', async (importOriginal) => ({
  ...await importOriginal(), default: dynamics,
}));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({ default: {} }));
vi.mock('../src/services/v1/ReplicationService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/MessageService.js', () => ({ default: { findBySession: vi.fn(), create: vi.fn() } }));
vi.mock('../src/services/v1/SessionService.js', () => ({ default: { addMessage: vi.fn() } }));
vi.mock('../src/services/v1/SupervisorService.js', () => ({ default: { observeAsync: vi.fn() } }));
vi.mock('../src/utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import LukeService from '../src/services/v1/LukeService.js';
import MessageService from '../src/services/v1/MessageService.js';
import SessionService from '../src/services/v1/SessionService.js';
import SupervisorService from '../src/services/v1/SupervisorService.js';
import { appendOpeningPrompt, buildOpeningPrompt } from '../src/utils/openingPrompt.js';
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.clearAllMocks();
  dynamics.open.mockResolvedValue();
  dynamics.releaseOpening.mockResolvedValue();
  MessageService.findBySession.mockResolvedValue([]);
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('GEMINI_API_KEY', 'test');
});

describe('Luke transcript persistence', () => {
  test('serializes concurrent saves and waits for pending history before reconnecting', async () => {
    LukeService.initialize({});
    const { saveHistory, getHistory } = createServer.mock.calls[0][0].session;
    const userSession = { sessionId: 'session', leia: {} };
    let releaseUser;
    const saved = [];
    MessageService.create.mockImplementationOnce(() => new Promise((resolve) => {
      releaseUser = () => { saved.push({ id: 'user', isLeia: false, text: 'Pregunta' }); resolve(saved[0]); };
    })).mockImplementationOnce(async () => {
      const message = { id: 'assistant', isLeia: true, text: 'Respuesta' };
      saved.push(message);
      return message;
    });
    MessageService.findBySession.mockImplementation(async () => [...saved]);
    const userWrite = saveHistory(userSession, { role: 'user', text: 'Pregunta', final: true });
    // A reconnect may create a different userSession object for the same ID.
    const assistantWrite = saveHistory({ ...userSession }, { role: 'assistant', text: 'Respuesta', final: true });
    const history = getHistory({ ...userSession });
    await Promise.resolve();
    expect(MessageService.create).toHaveBeenCalledTimes(1);
    expect(MessageService.findBySession).not.toHaveBeenCalled();
    expect(SupervisorService.observeAsync).not.toHaveBeenCalled();
    releaseUser();
    await Promise.all([userWrite, assistantWrite]);
    expect(await history).toEqual([
      { role: 'user', text: 'Pregunta', final: true },
      { role: 'assistant', text: 'Respuesta', final: true },
    ]);
    expect(SessionService.addMessage.mock.calls).toEqual([['session', 'user'], ['session', 'assistant']]);
    expect(SupervisorService.observeAsync).toHaveBeenCalledOnce();
  });

  test('a failed save does not block following messages', async () => {
    LukeService.initialize({});
    const { saveHistory } = createServer.mock.calls[0][0].session;
    MessageService.create.mockRejectedValueOnce(new Error('Write failed')).mockResolvedValueOnce({ id: 'reply' });
    const userSession = { sessionId: 'session', leia: {} };
    await Promise.all([
      saveHistory(userSession, { role: 'user', text: 'Pregunta', final: true }),
      saveHistory(userSession, { role: 'assistant', text: 'Respuesta', final: true }),
    ]);
    expect(SessionService.addMessage).toHaveBeenCalledExactlyOnceWith('session', 'reply');
  });

  test('slow observations and writes in another session do not block new messages', async () => {
    LukeService.initialize({});
    const { saveHistory } = createServer.mock.calls[0][0].session;
    let releaseObservation, releaseOther;
    dynamics.observeSafely.mockImplementationOnce(() => new Promise((resolve) => { releaseObservation = resolve; }));
    MessageService.create.mockResolvedValue({ id: 'message' });
    const assistantWrite = saveHistory({ sessionId: 'session', leia: {} }, { role: 'assistant', text: 'Respuesta', final: true });
    await vi.waitFor(() => expect(releaseObservation).toBeTypeOf('function'));
    MessageService.create.mockImplementationOnce(() => new Promise((resolve) => { releaseOther = resolve; }));
    const otherWrite = saveHistory({ sessionId: 'other' }, { role: 'user', text: 'Otra sesión', final: true });
    await Promise.resolve();
    await saveHistory({ sessionId: 'session' }, { role: 'user', text: 'Siguiente pregunta', final: true });
    expect(SessionService.addMessage).toHaveBeenCalledTimes(2);
    releaseObservation();
    releaseOther({ id: 'other-message' });
    await Promise.all([assistantWrite, otherWrite]);
    expect(SessionService.addMessage).toHaveBeenCalledTimes(3);
  });
});
describe('Luke opening provider lifecycle', () => {
  test.each(['gemini', 'openai'])('%s reconnect replays the actual assistant opening', async (provider) => {
    LukeService.initialize({});
    const options = createServer.mock.calls[0][0];
    const opening = "Hi, I'll be conducting the interview with my AirPods.";
    const userSession = { sessionId: 'session', leia: { runnerConfiguration: { lukeConfig: { provider } }, leia: { spec: { behaviour: { spec: {
      description: 'Conduct the interview.',
      conversationDynamics: { leiaSpeaksFirst: { enabled: true, config: { firstMessage: opening } } },
    } } } } } };
    MessageService.findBySession.mockResolvedValue([{ isLeia: true, text: opening }]);
    const instructions = await options.session.getSystemInstruction(userSession);
    expect(instructions).toContain('Conduct the interview.');
    expect(instructions).not.toContain('=== CONVERSATION STARTUP ===');
    expect(instructions).not.toContain(opening);
    expect(await options.session.getHistory(userSession)).toEqual([
      { role: 'assistant', text: opening, final: true },
    ]);
  });

  test('OpenAI and Gemini receive the same opening instructions at system priority before audio readiness', async () => {
    LukeService.initialize({});
    const options = createServer.mock.calls[0][0];
    const opening = 'Introduce yourself and ask the participant for their name.';
    const userSession = { sessionId: 'session', leia: {
      runnerConfiguration: { lukeConfig: { provider: 'gemini', voice: 'Kore' } },
      leia: { spec: { behaviour: { spec: {
        description: 'Be passive. Never ask questions. Let the participant lead.',
        conversationDynamics: { leiaSpeaksFirst: { enabled: true, config: { firstMessage: opening } } },
      } } } },
    } };
    const geminiInstructions = await options.session.getSystemInstruction(userSession);
    userSession.leia.runnerConfiguration.lukeConfig.provider = 'openai';
    const openaiInstructions = await options.session.getSystemInstruction(userSession);
    expect(geminiInstructions).toBe(openaiInstructions);
    const base = geminiInstructions.split('\n\n=== CONVERSATION STARTUP ===')[0];
    expect(geminiInstructions).toBe(appendOpeningPrompt(base, opening));
    expect(geminiInstructions).toContain(buildOpeningPrompt(opening));
    expect(geminiInstructions).toContain('Never ask questions.');
    expect(geminiInstructions).toContain('do not read out or describe the instructions themselves');
    expect(dynamics.open).not.toHaveBeenCalled();
  });

  test.each([
    { provider: 'gemini', enabled: false },
    { provider: 'openai', enabled: false },
  ])('does not inject startup rules when disabled for %j', async ({ provider, enabled }) => {
    LukeService.initialize({});
    const options = createServer.mock.calls[0][0];
    const userSession = { sessionId: 'session', leia: {
      runnerConfiguration: { lukeConfig: { provider } },
      leia: { spec: { behaviour: { spec: {
        description: 'Conduct an interview.',
        conversationDynamics: { leiaSpeaksFirst: { enabled, config: { firstMessage: 'Hello!' } } },
      } } } },
    } };
    expect(await options.session.getSystemInstruction(userSession)).not.toContain('=== CONVERSATION STARTUP ===');
    expect(MessageService.findBySession).not.toHaveBeenCalled();
  });
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
