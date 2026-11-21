import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { ObjectId } = mongoose.Types;

export function deriveLegacyStageId(seed) {
  const hash = createHash('sha256')
    .update(`leia-legacy-stage:v1:${String(seed)}`)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function leiaEntryId(entry) {
  return String(entry?.id ?? entry?._id ?? '');
}

function normalizeLegacyOrchestration(orch, leias) {
  const mode = orch?.mode === 'multi' ? 'multi' : 'single';
  const sharedTask = typeof orch?.sharedTask === 'string' ? orch.sharedTask : '';

  if (mode !== 'multi') {
    return {
      mode: 'single',
      maxInternalTurns: 2,
      openingLeiaId: null,
      problemLeiaId: null,
      sharedTask,
    };
  }

  const rawTurns = Number(orch?.maxInternalTurns);
  const maxInternalTurns = Number.isFinite(rawTurns)
    ? Math.min(Math.max(Math.trunc(rawTurns), 1), 8)
    : 2;

  const openingLeiaId =
    orch?.openingLeiaId != null ? String(orch.openingLeiaId) : leiaEntryId(leias[0]);
  const problemLeiaId =
    orch?.problemLeiaId != null ? String(orch.problemLeiaId) : openingLeiaId;

  return {
    mode: 'multi',
    maxInternalTurns,
    openingLeiaId,
    problemLeiaId,
    sharedTask,
  };
}

export async function buildPlan(db, { skipTestSessions = false } = {}) {
  const replicationsCollection = db.collection('replications');
  const sessionsCollection = db.collection('sessions');
  const activityRunsCollection = db.collection('activityruns');

  const [replications, sessions, existingRuns] = await Promise.all([
    replicationsCollection.find({}).toArray(),
    sessionsCollection.find({}).toArray(),
    activityRunsCollection.find({}).toArray(),
  ]);

  const repStats = {
    scanned: replications.length,
    alreadyMigrated: 0,
    toMigrate: 0,
    singleMode: 0,
    multiMode: 0,
    rootOrchestrationToUnset: 0,
  };

  const sessionStats = {
    scanned: sessions.length,
    alreadyMigrated: 0,
    toBackfill: 0,
    backfillParticipant: 0,
    backfillTest: 0,
    runsToCreate: 0,
    runsCarryingDataUsage: 0,
    skippedTestSessions: 0,
    orphanSessionsSkipped: 0,
    orphanParticipant: 0,
    orphanTest: 0,
  };

  const blockingIssues = [];
  const warnings = {
    replicationsWithZeroLeias: [],
    orphanSessionIds: [],
    sessionsMissingLeiaInReplication: [],
  };

  const replicationOperations = [];
  const repById = new Map();
  const effectiveStagesByRepId = new Map();

  for (const rep of replications) {
    const repId = String(rep._id);
    repById.set(repId, rep);

    const exp = rep.experiment || {};
    const leias = Array.isArray(exp.leias) ? exp.leias : [];
    const hasStages = Array.isArray(exp.stages) && exp.stages.length > 0;
    const hasRootOrchestration = Object.prototype.hasOwnProperty.call(exp, 'orchestration');
    const missingStageIdCount = leias.filter((entry) => !entry.stageId).length;

    if (hasStages && !hasRootOrchestration && missingStageIdCount === 0) {
      repStats.alreadyMigrated += 1;
      effectiveStagesByRepId.set(repId, exp.stages);
      continue;
    }

    if (hasStages && exp.stages.length > 1 && missingStageIdCount > 0) {
      blockingIssues.push({
        type: 'replication',
        id: repId,
        reason: 'Multi-stage replication has LEIA entries missing stageId',
      });
      continue;
    }

    const stageId = hasStages
      ? exp.stages[0].id
      : deriveLegacyStageId(exp.id || exp._id || rep._id);
    const sourceOrch = hasStages ? exp.stages[0].orchestration : exp.orchestration;
    const leiaIds = new Set(leias.map(leiaEntryId).filter(Boolean));

    if (sourceOrch?.mode === 'multi') {
      if (leias.length < 2) {
        blockingIssues.push({
          type: 'replication',
          id: repId,
          reason: 'MultiLEIA replication has fewer than 2 LEIAs',
        });
        continue;
      }
      if (leias.some((entry) => Boolean(entry.runnerConfiguration?.audioMode))) {
        blockingIssues.push({
          type: 'replication',
          id: repId,
          reason: 'MultiLEIA replication has a LEIA with audioMode enabled',
        });
        continue;
      }
      let badRef = false;
      for (const field of ['openingLeiaId', 'problemLeiaId']) {
        const refVal = sourceOrch[field];
        if (refVal != null && !leiaIds.has(String(refVal))) {
          blockingIssues.push({
            type: 'replication',
            id: repId,
            reason: `experiment.orchestration.${field} (${String(refVal)}) does not match any LEIA in the replication`,
          });
          badRef = true;
        }
      }
      if (badRef) continue;
    }

    if (leias.length === 0) {
      warnings.replicationsWithZeroLeias.push(repId);
    }

    const normalizedOrch = normalizeLegacyOrchestration(sourceOrch, leias);
    const nextStages = hasStages
      ? exp.stages.map((stage, idx) =>
          idx === 0
            ? {
                ...stage,
                outputSources: stage.outputSources ?? {
                  conversation: null,
                  submitedSolution: null,
                },
                orchestration: normalizedOrch,
              }
            : stage
        )
      : [
          {
            id: stageId,
            outputSources: {
              conversation: null,
              submitedSolution: null,
            },
            orchestration: normalizedOrch,
          },
        ];

    effectiveStagesByRepId.set(repId, nextStages);

    const nextLeias = leias.map((entry) =>
      entry.stageId ? entry : { ...entry, stageId }
    );

    repStats.toMigrate += 1;
    if (normalizedOrch.mode === 'multi') repStats.multiMode += 1;
    else repStats.singleMode += 1;
    if (hasRootOrchestration) repStats.rootOrchestrationToUnset += 1;

    const update = {
      $set: {
        'experiment.stages': nextStages,
        'experiment.leias': nextLeias,
      },
    };
    if (hasRootOrchestration) {
      update.$unset = { 'experiment.orchestration': '' };
    }

    replicationOperations.push({
      updateOne: {
        filter: {
          _id: rep._id,
          $or: [
            { 'experiment.stages': { $exists: false } },
            { 'experiment.stages': { $size: 0 } },
            { 'experiment.orchestration': { $exists: true } },
            { 'experiment.leias.stageId': { $exists: false } },
          ],
        },
        update,
      },
    });
  }

  // Preflight: ensure at most one open participant session per (user, replication)
  const openParticipantByUserRep = new Map();
  for (const s of sessions) {
    if (!s.isTest && s.finishedAt == null && s.user != null) {
      if (!repById.has(String(s.replication))) continue;
      const key = `${String(s.user)}:${String(s.replication)}`;
      const list = openParticipantByUserRep.get(key) || [];
      list.push(String(s._id));
      openParticipantByUserRep.set(key, list);
    }
  }
  for (const [key, sessionIds] of openParticipantByUserRep.entries()) {
    if (sessionIds.length > 1) {
      blockingIssues.push({
        type: 'session-collision',
        id: key,
        reason: `Multiple open participant sessions (${sessionIds.join(', ')}) violate ActivityRun unique open-run index`,
      });
    }
  }

  const runBySessionId = new Map();
  const runById = new Map();
  for (const run of existingRuns) {
    runById.set(String(run._id), run);
    for (const stageEntry of run.stages || []) {
      if (stageEntry?.session) {
        runBySessionId.set(String(stageEntry.session), run);
      }
    }
  }

  const seenStageRunKeys = new Set();
  for (const s of sessions) {
    if (s.stageRunKey) {
      if (seenStageRunKeys.has(s.stageRunKey)) {
        blockingIssues.push({
          type: 'session',
          id: String(s._id),
          reason: `Duplicate stageRunKey detected: ${s.stageRunKey}`,
        });
      }
      seenStageRunKeys.add(s.stageRunKey);
    }
  }

  const newActivityRuns = [];
  const sessionOperations = [];

  for (const s of sessions) {
    const sessionId = String(s._id);
    if (skipTestSessions && s.isTest) {
      sessionStats.skippedTestSessions += 1;
      continue;
    }

    const alreadyMigrated =
      s.run != null &&
      typeof s.stageId === 'string' &&
      s.stageId.length > 0 &&
      typeof s.stageIndex === 'number' &&
      typeof s.stageRunKey === 'string' &&
      s.stageRunKey.length > 0;

    if (alreadyMigrated) {
      sessionStats.alreadyMigrated += 1;
      continue;
    }

    const rep = repById.get(String(s.replication));
    if (!rep) {
      sessionStats.orphanSessionsSkipped += 1;
      if (s.isTest) sessionStats.orphanTest += 1;
      else sessionStats.orphanParticipant += 1;
      warnings.orphanSessionIds.push(sessionId);
      continue;
    }

    const stages = effectiveStagesByRepId.get(String(rep._id));
    if (!stages || stages.length === 0) {
      // Replication was skipped due to a blocking issue.
      continue;
    }

    const repLeias = rep.experiment?.leias || [];
    if (!repLeias.some((entry) => leiaEntryId(entry) === String(s.leia))) {
      warnings.sessionsMissingLeiaInReplication.push(sessionId);
    }

    let stageIndex =
      typeof s.stageId === 'string'
        ? stages.findIndex((stage) => stage.id === s.stageId)
        : -1;
    if (stageIndex < 0) stageIndex = 0;
    const stageId = stages[stageIndex].id;

    let run = runBySessionId.get(sessionId);
    if (!run && s.run) {
      run = runById.get(String(s.run));
    }

    let runId;
    if (run) {
      runId = run._id;
    } else {
      runId = new ObjectId();
      const newRun = {
        _id: runId,
        ...(s.user ? { user: s.user } : {}),
        replication: s.replication,
        isTest: Boolean(s.isTest),
        startedAt: s.startedAt || s._id.getTimestamp(),
        finishedAt: s.finishedAt ?? null,
        currentStageIndex: stageIndex,
        stages: [{ stageId, stageIndex, session: s._id }],
        ...(s.dataUsage ? { dataUsage: s.dataUsage } : {}),
      };
      newActivityRuns.push(newRun);
      sessionStats.runsToCreate += 1;
      if (s.dataUsage) sessionStats.runsCarryingDataUsage += 1;
    }

    const stageRunKey = s.stageRunKey || `run:${String(runId)}:stage:${stageId}`;
    if (!s.stageRunKey && seenStageRunKeys.has(stageRunKey)) {
      blockingIssues.push({
        type: 'session',
        id: sessionId,
        reason: `Generated stageRunKey collides with existing session: ${stageRunKey}`,
      });
      continue;
    }
    seenStageRunKeys.add(stageRunKey);

    sessionStats.toBackfill += 1;
    if (s.isTest) sessionStats.backfillTest += 1;
    else sessionStats.backfillParticipant += 1;

    sessionOperations.push({
      updateOne: {
        filter: {
          _id: s._id,
          $or: [
            { run: { $exists: false } },
            { run: null },
            { stageId: { $exists: false } },
            { stageIndex: { $exists: false } },
            { stageRunKey: { $exists: false } },
          ],
        },
        update: {
          $set: {
            run: runId,
            stageId,
            stageIndex,
            stageRunKey,
          },
        },
      },
    });
  }

  return {
    repStats,
    sessionStats,
    blockingIssues,
    warnings,
    replicationOperations,
    newActivityRuns,
    sessionOperations,
  };
}

export async function executePlan(db, plan) {
  if (plan.blockingIssues.length > 0) {
    throw new Error(
      `Cannot apply migration with ${plan.blockingIssues.length} blocking issue(s)`
    );
  }

  const repResult =
    plan.replicationOperations.length > 0
      ? await db
          .collection('replications')
          .bulkWrite(plan.replicationOperations, { ordered: true })
      : { matchedCount: 0, modifiedCount: 0 };

  const runsResult =
    plan.newActivityRuns.length > 0
      ? await db
          .collection('activityruns')
          .insertMany(plan.newActivityRuns, { ordered: true })
      : { insertedCount: 0 };

  const sessionResult =
    plan.sessionOperations.length > 0
      ? await db
          .collection('sessions')
          .bulkWrite(plan.sessionOperations, { ordered: true })
      : { matchedCount: 0, modifiedCount: 0 };

  return { repResult, runsResult, sessionResult };
}

function printReport(plan, { apply, verbose, dbName }) {
  const { repStats, sessionStats, blockingIssues, warnings } = plan;
  console.log(apply ? 'Mode: APPLY' : 'Mode: DRY RUN (pass --apply to write changes)');
  if (dbName) console.log(`Database: ${dbName}`);

  console.log(`Replications scanned: ${repStats.scanned}`);
  console.log(`  Already migrated: ${repStats.alreadyMigrated}`);
  console.log(
    `  To migrate: ${repStats.toMigrate} (multi: ${repStats.multiMode}, single: ${repStats.singleMode})`
  );
  console.log(`  Root experiment.orchestration to unset: ${repStats.rootOrchestrationToUnset}`);

  console.log(`Sessions scanned: ${sessionStats.scanned}`);
  console.log(`  Already migrated (has run & stageId): ${sessionStats.alreadyMigrated}`);
  console.log(
    `  To backfill: ${sessionStats.toBackfill} (participant: ${sessionStats.backfillParticipant}, test: ${sessionStats.backfillTest})`
  );
  console.log(`    - ActivityRuns to create: ${sessionStats.runsToCreate}`);
  console.log(`    - ActivityRuns carrying session.dataUsage: ${sessionStats.runsCarryingDataUsage}`);
  if (sessionStats.skippedTestSessions > 0) {
    console.log(`  Test sessions skipped (--skip-test-sessions): ${sessionStats.skippedTestSessions}`);
  }
  console.log(
    `  Orphan sessions skipped (missing replication): ${sessionStats.orphanSessionsSkipped} (participant: ${sessionStats.orphanParticipant}, test: ${sessionStats.orphanTest})`
  );

  console.log(`Blocking issues: ${blockingIssues.length}`);
  if (verbose && blockingIssues.length > 0) {
    for (const issue of blockingIssues) {
      console.log(`  [BLOCKING] ${issue.type} ${issue.id}: ${issue.reason}`);
    }
  }

  console.log('Warnings:');
  console.log(`  - Replications with 0 LEIAs: ${warnings.replicationsWithZeroLeias.length}`);
  console.log(`  - Orphan sessions skipped: ${warnings.orphanSessionIds.length}`);
  console.log(
    `  - Sessions whose leia is missing in replication: ${warnings.sessionsMissingLeiaInReplication.length}`
  );
  if (verbose) {
    if (warnings.replicationsWithZeroLeias.length) {
      console.log(
        `    replicationsWithZeroLeias: ${warnings.replicationsWithZeroLeias.join(', ')}`
      );
    }
    if (warnings.orphanSessionIds.length) {
      console.log(`    orphanSessionIds: ${warnings.orphanSessionIds.join(', ')}`);
    }
    if (warnings.sessionsMissingLeiaInReplication.length) {
      console.log(
        `    sessionsMissingLeiaInReplication: ${warnings.sessionsMissingLeiaInReplication.join(', ')}`
      );
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const verbose = process.argv.includes('--verbose');
  const skipTestSessions = process.argv.includes('--skip-test-sessions');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const db = mongoose.connection.db;
    const plan = await buildPlan(db, { skipTestSessions });
    printReport(plan, { apply, verbose, dbName: db.databaseName });

    if (!apply) return;

    const { repResult, runsResult, sessionResult } = await executePlan(db, plan);
    console.log(
      `Replications matched: ${repResult.matchedCount}, modified: ${repResult.modifiedCount}`
    );
    console.log(`ActivityRuns inserted: ${runsResult.insertedCount}`);
    console.log(
      `Sessions matched: ${sessionResult.matchedCount}, modified: ${sessionResult.modifiedCount}`
    );
  } finally {
    await mongoose.disconnect();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
