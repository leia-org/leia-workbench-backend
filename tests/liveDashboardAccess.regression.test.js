import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';

const socketState = vi.hoisted(() => ({
  middlewares: [],
  connectionHandlers: [],
  rooms: new Map(),
  sockets: new Map(),
}));

vi.mock('socket.io', () => ({
  Server: vi.fn(() => ({
    use: (fn) => socketState.middlewares.push(fn),
    on: (event, fn) => {
      if (event === 'connection') socketState.connectionHandlers.push(fn);
    },
    to: () => ({ emit: vi.fn() }),
    sockets: {
      adapter: { rooms: socketState.rooms },
      sockets: socketState.sockets,
    },
  })),
}));

vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({
  default: {
    findById: vi.fn(),
    checkSharedAccess: vi.fn(),
  },
}));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({
  default: {
    findById: vi.fn(),
    findByReplicationAndPopulateMessages: vi.fn(),
  },
}));
vi.mock('../src/services/v1/ManagerService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/InteractionService.js', () => ({ default: {} }));
vi.mock('../src/services/v1/TestRunService.js', () => ({
  default: { liveSummariesBySession: vi.fn() },
}));
vi.mock('../src/utils/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import replicationRepository from '../src/repositories/v1/ReplicationRepository.js';
import sessionRepository from '../src/repositories/v1/SessionRepository.js';
import spectatorRoutes from '../src/routes/v1/spectatorRoutes.js';
import errorHandler from '../src/middlewares/errorHandler.js';
import { initializeSocket, emitToReplicationAdmins } from '../src/socket/index.js';

let server;
let baseUrl;
let replication;
let sessions;
const secret = 'live-dashboard-regression-secret';

const signUser = (id, role = 'advanced') =>
  jwt.sign({ id, role }, secret, { expiresIn: '5m' });
const authHeaders = (id, role = 'advanced') => ({
  Authorization: `Bearer ${signUser(id, role)}`,
});

function createMockSocket(id, auth) {
  const listeners = new Map();
  const emitted = [];
  const socket = {
    id,
    handshake: { auth },
    on: (event, handler) => listeners.set(event, handler),
    emit: (event, payload) => emitted.push({ event, payload }),
    join: (room) => {
      if (!socketState.rooms.has(room)) socketState.rooms.set(room, new Set());
      socketState.rooms.get(room).add(id);
    },
    leave: (room) => {
      socketState.rooms.get(room)?.delete(id);
    },
    _trigger: async (event, payload) => {
      const handler = listeners.get(event);
      if (handler) await handler(payload);
    },
    _emitted: emitted,
  };
  socketState.sockets.set(id, socket);
  return socket;
}

async function connectSocket(id, auth) {
  const socket = createMockSocket(id, auth);
  for (const mw of socketState.middlewares) {
    let mwErr = null;
    mw(socket, (err) => {
      mwErr = err || null;
    });
    if (mwErr) throw mwErr;
  }
  for (const handler of socketState.connectionHandlers) {
    handler(socket);
  }
  return socket;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/spectator', spectatorRoutes);
  app.use(errorHandler);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  initializeSocket(server);
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  vi.resetAllMocks();
  socketState.rooms.clear();
  socketState.sockets.clear();
  vi.stubEnv('JWT_SECRET', secret);
  vi.stubEnv('JWT_ISSUER', '');
  vi.stubEnv('JWT_AUDIENCE', '');
  vi.stubEnv('FRONTEND_URL', 'http://localhost:8080');

  replication = {
    id: 'rep-1',
    user: 'adv-owner',
    experiment: {
      user: 'adv-owner',
      stages: [{ id: 'st-1' }],
    },
  };
  sessions = [
    {
      id: 'sess-1',
      replication: 'rep-1',
      user: { id: 'student-1', email: 'student@example.com' },
      leia: 'slot-1',
      startedAt: '2026-11-20T10:00:00Z',
      finishedAt: null,
      messages: [{ text: 'Hello', isLeia: false, timestamp: '2026-11-20T10:01:00Z' }],
      supervisorFlags: [{ category: 'off_topic', summary: 'Drifted off topic' }],
    },
  ];

  replicationRepository.findById.mockImplementation(async (id) =>
    id === 'rep-1' ? replication : null
  );
  replicationRepository.checkSharedAccess.mockImplementation(
    async (id, token) => id === 'rep-1' && token === 'valid-share-token'
  );
  sessionRepository.findByReplicationAndPopulateMessages.mockImplementation(async (id) =>
    id === 'rep-1' ? sessions : []
  );
  sessionRepository.findById.mockImplementation(async (id) =>
    id === 'sess-1' ? sessions[0] : null
  );
});

afterEach(() => vi.unstubAllEnvs());

describe('Live Dashboard HTTP access for advanced users', () => {
  test('allows an advanced owner to fetch live sessions including supervisor flags', async () => {
    const res = await fetch(`${baseUrl}/api/v1/spectator/replications/rep-1/sessions`, {
      headers: authHeaders('adv-owner', 'advanced'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.sessions[0].supervisorFlags).toEqual([
      { category: 'off_topic', summary: 'Drifted off topic' },
    ]);
    expect(body.sessions[0].supervisorFlagCount).toBe(1);
  });

  test('allows an admin non-owner to fetch live sessions including supervisor flags', async () => {
    const res = await fetch(`${baseUrl}/api/v1/spectator/replications/rep-1/sessions`, {
      headers: authHeaders('admin-1', 'admin'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions[0].supervisorFlagCount).toBe(1);
  });

  test('denies an advanced user who does not own the replication with 403', async () => {
    const res = await fetch(`${baseUrl}/api/v1/spectator/replications/rep-1/sessions`, {
      headers: authHeaders('other-adv', 'advanced'),
    });
    expect(res.status).toBe(403);
    expect(sessionRepository.findByReplicationAndPopulateMessages).not.toHaveBeenCalled();
  });

  test('allows an advanced non-owner with a valid share token without exposing supervisor flags', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/spectator/replications/rep-1/sessions?token=valid-share-token`,
      { headers: authHeaders('other-adv', 'advanced') }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.sessions[0].supervisorFlags).toBeUndefined();
    expect(body.sessions[0].supervisorFlagCount).toBeUndefined();
  });

  test('allows anonymous share-token viewers without exposing supervisor flags', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/spectator/replications/rep-1/sessions?token=valid-share-token`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.sessions[0].supervisorFlags).toBeUndefined();
  });

  test('rejects forged bearer JWT even when a valid share token is present', async () => {
    const forged = jwt.sign({ id: 'adv-owner', role: 'advanced' }, 'wrong-secret');
    const res = await fetch(
      `${baseUrl}/api/v1/spectator/replications/rep-1/sessions?token=valid-share-token`,
      { headers: { Authorization: `Bearer ${forged}` } }
    );
    expect(res.status).toBe(401);
  });

  test('allows an advanced owner to generate a spectate token for a session in their replication', async () => {
    const res = await fetch(`${baseUrl}/api/v1/spectator/sessions/sess-1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders('adv-owner', 'advanced') },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.spectateUrl).toContain('/spectate/sess-1?token=');
  });

  test('allows an admin and a valid share-token viewer to generate a spectate token', async () => {
    const adminRes = await fetch(`${baseUrl}/api/v1/spectator/sessions/sess-1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders('admin-1', 'admin') },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    expect(adminRes.status).toBe(200);

    const sharedRes = await fetch(
      `${baseUrl}/api/v1/spectator/sessions/sess-1/token?token=valid-share-token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 3600 }),
      }
    );
    expect(sharedRes.status).toBe(200);
  });

  test('denies spectate token generation for an advanced non-owner and returns 404 for unknown sessions', async () => {
    const denied = await fetch(`${baseUrl}/api/v1/spectator/sessions/sess-1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders('other-adv', 'advanced') },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    expect(denied.status).toBe(403);

    const missing = await fetch(`${baseUrl}/api/v1/spectator/sessions/missing-sess/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders('adv-owner', 'advanced') },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    expect(missing.status).toBe(404);
  });
});

describe('Live Dashboard Socket.IO access for advanced users', () => {
  test('allows an advanced owner to join dashboard, receive supervisor flags, and spectate own sessions', async () => {
    const ownerSocket = await connectSocket('sock-owner', { token: signUser('adv-owner', 'advanced') });
    await ownerSocket._trigger('dashboard:join', 'rep-1');

    expect(ownerSocket._emitted).toContainEqual({
      event: 'dashboard:joined',
      payload: { replicationId: 'rep-1' },
    });

    emitToReplicationAdmins('rep-1', 'session:supervisorFlag', { sessionId: 'sess-1', flags: [] });
    expect(ownerSocket._emitted).toContainEqual({
      event: 'session:supervisorFlag',
      payload: { sessionId: 'sess-1', flags: [] },
    });

    await ownerSocket._trigger('spectate:join', 'sess-1');
    expect(ownerSocket._emitted).toContainEqual({
      event: 'spectate:joined',
      payload: { sessionId: 'sess-1' },
    });
  });

  test('denies an advanced non-owner without share token on dashboard:join and spectate:join', async () => {
    const otherSocket = await connectSocket('sock-other', { token: signUser('other-adv', 'advanced') });
    await otherSocket._trigger('dashboard:join', 'rep-1');
    expect(otherSocket._emitted).toContainEqual({
      event: 'dashboard:error',
      payload: { message: 'Access denied' },
    });

    await otherSocket._trigger('spectate:join', 'sess-1');
    expect(otherSocket._emitted).toContainEqual({
      event: 'spectate:error',
      payload: { message: 'Spectate access denied' },
    });
  });

  test('allows an advanced non-owner with valid share token on dashboard:join without supervisor flags', async () => {
    const sharedAdvSocket = await connectSocket('sock-shared-adv', {
      token: signUser('other-adv', 'advanced'),
      shareToken: 'valid-share-token',
    });
    const anonSocket = await connectSocket('sock-anon', { shareToken: 'valid-share-token' });
    const adminSocket = await connectSocket('sock-admin', { token: signUser('admin-1', 'admin') });

    await sharedAdvSocket._trigger('dashboard:join', 'rep-1');
    await anonSocket._trigger('dashboard:join', 'rep-1');
    await adminSocket._trigger('dashboard:join', 'rep-1');

    expect(sharedAdvSocket._emitted).toContainEqual({
      event: 'dashboard:joined',
      payload: { replicationId: 'rep-1' },
    });

    emitToReplicationAdmins('rep-1', 'session:supervisorFlag', { sessionId: 'sess-1', flags: [] });
    expect(
      sharedAdvSocket._emitted.some((e) => e.event === 'session:supervisorFlag')
    ).toBe(false);
    expect(anonSocket._emitted.some((e) => e.event === 'session:supervisorFlag')).toBe(false);
    expect(adminSocket._emitted).toContainEqual({
      event: 'session:supervisorFlag',
      payload: { sessionId: 'sess-1', flags: [] },
    });
  });
});
