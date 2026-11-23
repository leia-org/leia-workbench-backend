import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';

vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({ default: {
  findById: vi.fn(), checkSharedAccess: vi.fn(),
} }));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({ default: {} }));
vi.mock('../src/services/v1/ManagerService.js', () => ({ default: {} }));
vi.mock('../src/utils/logger.js', () => ({ default: { debug: vi.fn(), error: vi.fn() } }));

import repository from '../src/repositories/v1/ReplicationRepository.js';
import { authContext } from '../src/middlewares/auth.js';
import errorHandler from '../src/middlewares/errorHandler.js';

let server, baseUrl, replication;
const secret = 'regression-only-signing-secret';
const headers = (id = 'owner', role = 'advanced') => ({ Authorization: `Bearer ${jwt.sign({ id, role }, secret, { expiresIn: '5m' })}` });
const request = (query = '', requestHeaders = {}) => fetch(`${baseUrl}/replications/replication${query}`, { headers: requestHeaders });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Exercise the actual middleware/service boundary used by every protected replication route.
  app.get('/replications/:id', authContext, (req, res) => res.json({ id: req.replication.id, user: req.user }));
  app.use(errorHandler);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('JWT_SECRET', secret);
  vi.stubEnv('JWT_ISSUER', '');
  vi.stubEnv('JWT_AUDIENCE', '');
  replication = { id: 'replication', experiment: { user: 'owner' } };
  repository.findById.mockImplementation(async () => replication);
  repository.checkSharedAccess.mockImplementation(async (id, token) => id === 'replication' && token === 'valid-share-token');
});
afterEach(() => vi.unstubAllEnvs());

describe('Workbench replication access regressions', () => {
  test.each(['owner', { id: 'owner' }, { _id: 'owner' }])('recognizes the owner in legacy and populated experiments: %j', async (owner) => {
    replication.experiment.user = owner;
    const res = await request('', headers());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'replication', user: { id: 'owner' } });
    expect(repository.checkSharedAccess).not.toHaveBeenCalled();
  });

  test('allows an admin even if they do not own the replication', async () => {
    const res = await request('', headers('other-user', 'admin'));
    expect(res.status).toBe(200);
    expect(repository.checkSharedAccess).not.toHaveBeenCalled();
  });

  test('denies another authenticated user with 403 rather than 500', async () => {
    const res = await request('', headers('other-user'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'Access denied' });
  });

  test.each(['', '?token=invalid-share-token'])('denies anonymous or invalid shared access: %s', async (query) => {
    const res = await request(query);
    expect(res.status).toBe(403);
  });

  test('accepts a valid share token scoped to the requested replication', async () => {
    const res = await request('?token=valid-share-token');
    expect(res.status).toBe(200);
    expect(repository.checkSharedAccess).toHaveBeenCalledExactlyOnceWith('replication', 'valid-share-token');
    expect(await res.json()).toEqual({ id: 'replication', user: { shareToken: 'valid-share-token' } });
  });

  test.each([
    () => jwt.sign({ id: 'intruder', role: 'admin' }, 'wrong-secret'),
    () => jwt.sign({ id: 'owner', role: 'admin' }, secret, { expiresIn: -1 }),
  ])('a share token cannot mask a forged or expired admin bearer token', async (invalidToken) => {
    const res = await request('?token=valid-share-token', { Authorization: `Bearer ${invalidToken()}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: 'Invalid or expired token' });
    expect(repository.findById).not.toHaveBeenCalled();
  });

  test('database failures remain server errors rather than being reported as expired authentication', async () => {
    repository.findById.mockRejectedValueOnce(new Error('Database unavailable'));
    const res = await request('', headers());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: 'Database unavailable' });
  });

  test('missing replications return 404 before checking shared access', async () => {
    replication = null;
    const res = await request('', headers());
    expect(res.status).toBe(404);
    expect(repository.checkSharedAccess).not.toHaveBeenCalled();
  });
});
