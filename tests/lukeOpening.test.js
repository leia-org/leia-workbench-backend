import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const luke = vi.hoisted(() => ({ config: null }));
vi.mock('@leia-org/luke-server', () => ({
  createLukeServer: vi.fn((config) => {
    luke.config = config;
    return {};
  }),
  openai: vi.fn(() => ({ id: 'openai' })),
  gemini: vi.fn(() => ({ id: 'gemini' })),
}));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({ default: {
  claimLukeOpening: vi.fn(),
  releaseLukeOpening: vi.fn(),
} }));
vi.mock('../src/utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import LukeService from '../src/services/v1/LukeService.js';
import SessionRepository from '../src/repositories/v1/SessionRepository.js';

const sessionData = {
  sessionId: 'session-1',
  session: { id: 'session-1', interactionMode: 'single' },
  leia: {
    runnerConfiguration: { audioMode: 'luke' },
    configuration: {},
    leia: { spec: { behaviour: { spec: {
      conversationDynamics: { speaksFirst: { enabled: true, prompt: 'Greet the student' } },
    } } } },
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = 'test-key';
  SessionRepository.claimLukeOpening.mockResolvedValue({ lukeOpeningStartedAt: new Date() });
  SessionRepository.releaseLukeOpening.mockResolvedValue({});
  LukeService.initialize({});
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.OPENAI_API_KEY;
});

describe('Luke speaks first', () => {
  test('opens once on the final provider connection and does not repeat after reconnecting', async () => {
    const initial = { send: vi.fn() };
    const selected = { send: vi.fn() };
    const lukeSession = { userSession: sessionData, providerConnection: initial };
    luke.config.onConnect(lukeSession);
    lukeSession.providerConnection = selected;
    luke.config.onConnect(lukeSession);
    await vi.advanceTimersByTimeAsync(300);

    expect(initial.send).not.toHaveBeenCalled();
    expect(selected.send).toHaveBeenCalledExactlyOnceWith({
      type: 'text', content: 'Begin the conversation with your opening message.',
    });
    expect(SessionRepository.claimLukeOpening).toHaveBeenCalledExactlyOnceWith('session-1');

    SessionRepository.claimLukeOpening.mockResolvedValueOnce(null);
    luke.config.onDisconnect(lukeSession);
    const reconnect = { userSession: sessionData, providerConnection: { send: vi.fn() } };
    luke.config.onConnect(reconnect);
    await vi.advanceTimersByTimeAsync(300);
    expect(reconnect.providerConnection.send).not.toHaveBeenCalled();
  });

  test('does not open when speaks first is disabled or consent is pending', async () => {
    const send = vi.fn();
    const userSession = structuredClone(sessionData);
    userSession.leia.leia.spec.behaviour.spec.conversationDynamics.speaksFirst.enabled = false;
    await LukeService.startOpening({ userSession, providerConnection: { send } });
    userSession.leia.leia.spec.behaviour.spec.conversationDynamics.speaksFirst.enabled = true;
    userSession.session.dataUsage = { config: { dataUsageConsentRequired: true }, consentStatus: 'pending' };
    await LukeService.startOpening({ userSession, providerConnection: { send } });
    expect(SessionRepository.claimLukeOpening).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test('releases the claim if the provider changes before the prompt is sent', async () => {
    const initial = { send: vi.fn() };
    const lukeSession = { userSession: sessionData, providerConnection: initial };
    SessionRepository.claimLukeOpening.mockImplementationOnce(async () => {
      lukeSession.providerConnection = { send: vi.fn() };
      return { lukeOpeningStartedAt: new Date('2026-01-01') };
    });
    await LukeService.startOpening(lukeSession);
    expect(initial.send).not.toHaveBeenCalled();
    expect(SessionRepository.releaseLukeOpening).toHaveBeenCalledOnce();
  });
});
