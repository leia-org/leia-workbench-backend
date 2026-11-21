import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  buildPlan,
  deriveLegacyStageId,
  executePlan,
} from '../scripts/migrate-staged-replications.js';

const { ObjectId } = mongoose.Types;

function makeMockDb({ replications = [], sessions = [], activityruns = [] }) {
  const repBulkWrite = vi.fn(async (ops) => ({
    matchedCount: ops.length,
    modifiedCount: ops.length,
  }));
  const runsInsertMany = vi.fn(async (docs) => ({
    insertedCount: docs.length,
  }));
  const sessBulkWrite = vi.fn(async (ops) => ({
    matchedCount: ops.length,
    modifiedCount: ops.length,
  }));

  return {
    collections: {
      replications: {
        find: () => ({ toArray: async () => replications }),
        bulkWrite: repBulkWrite,
      },
      sessions: {
        find: () => ({ toArray: async () => sessions }),
        bulkWrite: sessBulkWrite,
      },
      activityruns: {
        find: () => ({ toArray: async () => activityruns }),
        insertMany: runsInsertMany,
      },
    },
    collection(name) {
      return this.collections[name];
    },
  };
}

describe('migrate-staged-replications', () => {
  it('migrates legacy replications and backfills ActivityRun + Session preserving dataUsage', async () => {
    const repId = new ObjectId();
    const expId = new ObjectId();
    const leiaSlotId = new ObjectId();
    const userId = new ObjectId();
    const finishedSessionId = new ObjectId();
    const testSessionId = new ObjectId();
    const finishedAt = new Date('2026-10-01T10:00:00Z');
    const dataUsage = {
      config: { dataUsageConsentRequired: true },
      consentStatus: 'accepted',
      decidedAt: new Date('2026-10-01T09:50:00Z'),
      automatedRemovalApplied: false,
    };

    const db = makeMockDb({
      replications: [
        {
          _id: repId,
          experiment: {
            id: String(expId),
            name: 'Legacy Exp',
            orchestration: { mode: 'single', maxInternalTurns: 2, openingLeiaId: null, problemLeiaId: null, sharedTask: '' },
            leias: [{ id: String(leiaSlotId), configuration: { mode: 'standard' } }],
          },
        },
      ],
      sessions: [
        {
          _id: finishedSessionId,
          replication: repId,
          user: userId,
          leia: leiaSlotId,
          isTest: false,
          startedAt: new Date('2026-10-01T09:45:00Z'),
          finishedAt,
          dataUsage,
        },
        {
          _id: testSessionId,
          replication: repId,
          user: null,
          leia: leiaSlotId,
          isTest: true,
          startedAt: new Date('2026-10-01T09:40:00Z'),
        },
      ],
    });

    const plan = await buildPlan(db);
    expect(plan.blockingIssues).toEqual([]);
    expect(plan.repStats).toMatchObject({
      scanned: 1,
      toMigrate: 1,
      singleMode: 1,
      rootOrchestrationToUnset: 1,
    });
    expect(plan.sessionStats).toMatchObject({
      scanned: 2,
      toBackfill: 2,
      backfillParticipant: 1,
      backfillTest: 1,
      runsToCreate: 2,
      runsCarryingDataUsage: 1,
      orphanSessionsSkipped: 0,
    });

    const expectedStageId = deriveLegacyStageId(String(expId));
    expect(plan.replicationOperations[0].updateOne.update.$set['experiment.stages'][0].id).toBe(
      expectedStageId
    );
    expect(plan.replicationOperations[0].updateOne.update.$unset).toEqual({
      'experiment.orchestration': '',
    });

    const participantRun = plan.newActivityRuns[0];
    expect(participantRun.user).toEqual(userId);
    expect(participantRun.finishedAt).toEqual(finishedAt);
    expect(participantRun.dataUsage).toEqual(dataUsage);
    expect(participantRun.stages).toEqual([
      { stageId: expectedStageId, stageIndex: 0, session: finishedSessionId },
    ]);

    const testRun = plan.newActivityRuns[1];
    expect(testRun.user).toBeUndefined();
    expect(testRun.isTest).toBe(true);
    expect(testRun.finishedAt).toBeNull();
  });

  it('skips orphan sessions with warning and supports --skip-test-sessions', async () => {
    const repId = new ObjectId();
    const leiaSlotId = new ObjectId();
    const db = makeMockDb({
      replications: [
        {
          _id: repId,
          experiment: {
            id: String(new ObjectId()),
            leias: [{ id: String(leiaSlotId) }],
          },
        },
      ],
      sessions: [
        { _id: new ObjectId(), replication: new ObjectId(), leia: leiaSlotId, isTest: false },
        { _id: new ObjectId(), replication: repId, leia: leiaSlotId, isTest: true },
      ],
    });

    const plan = await buildPlan(db, { skipTestSessions: true });
    expect(plan.blockingIssues).toEqual([]);
    expect(plan.sessionStats.orphanSessionsSkipped).toBe(1);
    expect(plan.sessionStats.skippedTestSessions).toBe(1);
    expect(plan.sessionStats.toBackfill).toBe(0);
    expect(plan.warnings.orphanSessionIds).toHaveLength(1);
  });

  it('blocks when multiple open participant sessions exist for same user and replication', async () => {
    const repId = new ObjectId();
    const userId = new ObjectId();
    const leiaSlotId = new ObjectId();
    const db = makeMockDb({
      replications: [
        {
          _id: repId,
          experiment: { id: String(new ObjectId()), leias: [{ id: String(leiaSlotId) }] },
        },
      ],
      sessions: [
        { _id: new ObjectId(), replication: repId, user: userId, leia: leiaSlotId, isTest: false },
        { _id: new ObjectId(), replication: repId, user: userId, leia: leiaSlotId, isTest: false },
      ],
    });

    const plan = await buildPlan(db);
    expect(plan.blockingIssues).toHaveLength(1);
    expect(plan.blockingIssues[0].type).toBe('session-collision');
    await expect(executePlan(db, plan)).rejects.toThrow(/blocking issue/i);
  });
});
