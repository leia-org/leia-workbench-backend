// One-off migration: test runs used to live in their own `testruns`
// collection and are now events of type `test_run` in `events`.
//
//   MONGO_URI=mongodb://... node scripts/migrate-test-runs-to-events.js           (dry run)
//   MONGO_URI=mongodb://... node scripts/migrate-test-runs-to-events.js --apply
//
// Safe to run more than once: every event keeps the _id of its test run and
// is only inserted if it is not there yet. The old collection is left
// untouched; drop it by hand once the result has been checked.
import mongoose from 'mongoose';
import { pathToFileURL } from 'url';

const SOURCE = 'testruns';
const TARGET = 'events';

// The event a stored test run becomes. `session` is its Session document (or
// null when it no longer exists) and only contributes the activity position.
export function toEventDocument(run, session = null) {
  const results = Array.isArray(run.results) ? run.results : [];
  const code = typeof run.code === 'string' ? run.code : '';
  return {
    _id: run._id,
    session: run.session,
    replication: run.replication,
    ...(session?.run ? { run: session.run } : {}),
    ...(session?.stageId ? { stageId: session.stageId } : {}),
    ...(typeof session?.stageIndex === 'number' ? { stageIndex: session.stageIndex } : {}),
    type: 'test_run',
    source: 'code_editor',
    actor: run.trigger === 'leia' ? 'leia' : 'student',
    view: 'chat',
    payload: {
      language: run.language,
      fnName: run.fnName || '',
      results,
      error: run.error ?? null,
      durationMs: run.durationMs || 0,
      status: run.status,
      passed: run.passed ?? 0,
      failed: run.failed ?? 0,
      total: run.total ?? results.length,
    },
    content: code,
    hasContent: code.length > 0,
    contentTruncated: run.codeTruncated === true,
    clientEventId: run.clientRunId || `legacy-${run._id}`,
    clientAt: run.clientRunAt || run.createdAt,
    seq: 0,
    at: run.createdAt,
    ...(run.reportedToLeiaAt ? { reportedToLeiaAt: run.reportedToLeiaAt } : {}),
    createdAt: run.createdAt,
  };
}

/**
 * @param {import('mongodb').Db} db
 * @param {{ apply?: boolean }} [options] - Without `apply` nothing is written.
 * @returns {Promise<{ found: number, migrated: number, alreadyThere: number }>}
 */
export async function migrateTestRunsToEvents(db, { apply = false } = {}) {
  const summary = { found: 0, migrated: 0, alreadyThere: 0 };
  const sessions = db.collection('sessions');
  const events = db.collection(TARGET);

  for await (const run of db.collection(SOURCE).find({})) {
    summary.found += 1;
    if (await events.countDocuments({ _id: run._id }, { limit: 1 })) {
      summary.alreadyThere += 1;
      continue;
    }
    if (apply) {
      const session = await sessions.findOne(
        { _id: run.session },
        { projection: { run: 1, stageId: 1, stageIndex: 1 } }
      );
      const { _id, ...document } = toEventDocument(run, session);
      await events.updateOne({ _id }, { $setOnInsert: document }, { upsert: true });
    }
    summary.migrated += 1;
  }
  return summary;
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const summary = await migrateTestRunsToEvents(mongoose.connection.db, { apply });
    console.log(
      `${apply ? 'Migrated' : 'Would migrate'} ${summary.migrated} of ${summary.found} test runs ` +
        `(${summary.alreadyThere} already in ${TARGET}).${apply ? '' : ' Run again with --apply to write.'}`
    );
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
