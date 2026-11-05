import { describe, expect, test, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

vi.mock('../src/services/v1/ReplicationService.js', () => ({
  default: { findById: vi.fn(), checkAccess: vi.fn(), toggleIsShared: vi.fn(), regenerateShareToken: vi.fn() },
}));
vi.mock('../src/utils/jwt.js', () => ({ verifyToken: vi.fn() }));

import ReplicationService from '../src/services/v1/ReplicationService.js';
import { verifyToken } from '../src/utils/jwt.js';
import { authContext } from '../src/middlewares/auth.js';
import { toggleReplicationIsShared, regenerateReplicationShareToken } from '../src/controllers/v1/replicationController.js';
import { ownsReplication, replicationOwnershipQuery } from '../src/utils/replicationOwnership.js';
import Replication from '../src/models/Replication.js';

const id = '507f1f77bcf86cd799439011';
const otherId = '507f1f77bcf86cd799439012';
const advanced = { id, role: 'advanced' };

beforeEach(() => vi.clearAllMocks());

describe('replication ownership', () => {
  test.each([id, new mongoose.Types.ObjectId(id)])('accepts the creator %s', (user) => {
    expect(ownsReplication({ user, experiment: { user: otherId } }, advanced)).toBe(true);
  });

  test('serializes the creator and its alias', () => {
    const replication = new Replication({ user: id });
    expect(replication.userId.toHexString()).toBe(id);
    expect(JSON.parse(JSON.stringify(replication))).toMatchObject({ user: id, userId: id });
  });

  test.each([id, { id }, { _id: id }, new mongoose.Types.ObjectId(id)])('preserves the advanced legacy fallback %s', (user) => {
    expect(ownsReplication({ experiment: { user } }, advanced)).toBe(true);
    expect(ownsReplication({ experiment: { user } }, { id, role: 'instructor' })).toBe(false);
  });

  test('does not let the experiment owner override an explicit creator', () => {
    expect(ownsReplication({ user: otherId, experiment: { user: { id } } }, advanced)).toBe(false);
    expect(ownsReplication({}, {})).toBe(false);
  });

  test('lists creators and legacy experiment owners only when user is absent', () => {
    expect(replicationOwnershipQuery(id)).toEqual({ $or: [
      { user: id },
      { user: null, $or: [{ 'experiment.user.id': id }, { 'experiment.user._id': id }, { 'experiment.user': id }] },
    ] });
  });

  test.each([
    [{ user: id }, advanced, true],
    [{ experiment: { user: { id } } }, advanced, true],
    [{ user: otherId, experiment: { user: { id } } }, advanced, false],
    [{ experiment: { user: id } }, { id, role: 'instructor' }, false],
    [{ user: otherId }, { id, role: 'admin' }, true],
  ])('passes the same ownership decision to access checks', async (replication, user, allowed) => {
    verifyToken.mockReturnValue(user);
    ReplicationService.findById.mockResolvedValue(replication);
    const next = vi.fn();
    await authContext({ headers: { authorization: 'Bearer token' }, query: {}, params: { id: 'rep' } }, {}, next);
    expect(ReplicationService.checkAccess).toHaveBeenCalledWith('rep', allowed, undefined);
    expect(next).toHaveBeenCalledWith();
  });

  test.each([toggleReplicationIsShared, regenerateReplicationShareToken])('checks sharing ownership without requiring an experiment user', async (controller) => {
    ReplicationService.findById.mockResolvedValue({ user: new mongoose.Types.ObjectId(id) });
    const next = vi.fn();
    const res = { json: vi.fn() };
    const req = { params: { id: 'rep' }, auth: { payload: advanced } };
    await controller(req, res, next);
    expect(res.json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();

    ReplicationService.findById.mockResolvedValue({ user: otherId, experiment: { user: { id } } });
    await controller(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});
