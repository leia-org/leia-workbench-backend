import { randomUUID } from 'crypto';
import EventRepository from '../../repositories/v1/EventRepository.js';
import SessionRepository from '../../repositories/v1/SessionRepository.js';
import ReplicationRepository from '../../repositories/v1/ReplicationRepository.js';
import EventService from './EventService.js';
import { buildTestRunNote } from '../../utils/testRunNote.js';
import { toTestRun } from '../../utils/testRunView.js';
import { csvRow } from '../../utils/csv.js';

// Test runs are stored as events of type `test_run` (see EventService). This
// service is their typed view: the note for the LEIA, the per-run export and
// the test-run endpoints that predate the generic event API.

export { hasCodeEditorWidget, deriveOutcome } from '../../utils/eventTypes.js';

// How many pending runs are loaded to build the LEIA note. The note describes
// the latest one and only counts the rest.
const MAX_RUNS_IN_NOTE = 20;

// How many recent runs the live dashboard list carries per session.
const LIVE_RECENT_RUNS = 5;

const TEST_RUN = 'test_run';
// Runs the student started: the ones the LEIA has to be told about.
const STUDENT_RUNS = { type: TEST_RUN, actor: 'student' };

export const TEST_RUNS_CSV_HEADER = [
  'Session ID',
  'Run ID',
  'Stage',
  'User',
  'Test Run ID',
  'Run Number',
  'Timestamp',
  'Trigger',
  'Language',
  'Function',
  'Status',
  'Passed',
  'Failed',
  'Total',
  'Duration Ms',
  'Error',
  'Failed Tests',
  'Results JSON',
  'Reported To LEIA At',
  'Code Truncated',
  'Code',
];

// How a rejected event maps onto the status codes of POST /test-runs.
const REJECTION_STATUS = {
  validation: [400, 'Invalid test run'],
  unknown_type: [400, 'Invalid test run'],
  not_applicable: [409, 'This activity has no code editor'],
  cap_reached: [429, 'Too many test runs for this session'],
  session_finished: [403, 'Session is already finished'],
};

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const toIso = (value) => (value ? new Date(value).toISOString() : '');

// A run without its code snapshot, as plain JSON.
export function toSummary(event) {
  return toTestRun(event);
}

function groupBySession(runs) {
  const bySession = new Map();
  for (const run of runs) {
    const key = String(run.session);
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(run);
  }
  return bySession;
}

class TestRunService {
  // WRITE METHODS

  /**
   * Stores a test run reported through POST /test-runs as a `test_run` event.
   * @returns {Promise<{ run: object, created: boolean }>}
   */
  async record(sessionId, payload) {
    const clientEventId = payload.clientRunId || randomUUID();
    const { results, stored } = await EventService.recordBatch(
      sessionId,
      {
        events: [
          {
            clientEventId,
            type: TEST_RUN,
            source: 'code_editor',
            actor: payload.trigger,
            view: 'chat',
            clientAt: payload.clientRunAt || new Date(),
            payload: {
              language: payload.language,
              fnName: payload.fnName,
              results: payload.results,
              error: payload.error,
              durationMs: payload.durationMs,
            },
            content: payload.code ?? '',
            contentTruncated: payload.codeTruncated === true,
          },
        ],
      },
      // This endpoint never accepted anything once the session was finished.
      { finishedGraceMs: 0 }
    );

    const [result] = results;
    if (result.status === 'stored') {
      return { run: toTestRun(stored[0], { withCode: true }), created: true };
    }
    if (result.status === 'duplicate') {
      const existing = await EventRepository.findBySessionAndClientEventId(sessionId, clientEventId, {
        withContent: true,
      });
      if (existing) return { run: toTestRun(existing, { withCode: true }), created: false };
    }
    const [statusCode, message] = REJECTION_STATUS[result.reason] || [400, 'Test run was not stored'];
    throw httpError(result.message ? `${message}: ${result.message}` : message, statusCode);
  }

  async markReported(sessionId, upTo) {
    return await EventRepository.markReported(sessionId, STUDENT_RUNS, upTo);
  }

  // READ METHODS

  /**
   * Hidden context for the LEIA about student-triggered runs it has not seen.
   * @returns {Promise<{ context: string, upTo: Date } | null>} `upTo` is the
   *   reception time of the latest run described, to stamp once the runner
   *   confirms.
   */
  async pendingNote(sessionId, now = new Date()) {
    const events = await EventRepository.findUnreported(sessionId, STUDENT_RUNS, MAX_RUNS_IN_NOTE);
    if (events.length === 0) return null;

    const totalCount =
      events.length < MAX_RUNS_IN_NOTE
        ? events.length
        : await EventRepository.countUnreported(sessionId, STUDENT_RUNS);
    const runs = events.map((event) => toTestRun(event));
    const context = buildTestRunNote(runs, { now, totalCount });
    if (!context) return null;

    return { context, upTo: runs[runs.length - 1].createdAt };
  }

  // Map of session id -> run summaries (no code), chronological.
  async summariesBySession(replicationId) {
    const events = await EventRepository.findByReplication(replicationId, { type: TEST_RUN });
    return groupBySession(events.map((event) => toTestRun(event)));
  }

  // Adds `testRuns` (summaries, no code) to each session of a replication.
  // Done here rather than with a Session virtual so no other serialisation of
  // a session (student or spectator facing) can ever carry them.
  async attachSummaries(replicationId, sessions) {
    const bySession = await this.summariesBySession(replicationId);
    return sessions.map((session) => {
      const data = session && typeof session.toJSON === 'function' ? session.toJSON() : { ...session };
      return { ...data, testRuns: bySession.get(String(data.id)) || [] };
    });
  }

  // Map of session id -> { testRunCount, testRuns: latest summaries }.
  async liveSummariesBySession(replicationId) {
    const bySession = await this.summariesBySession(replicationId);
    const live = new Map();
    for (const [sessionId, runs] of bySession) {
      live.set(sessionId, { testRunCount: runs.length, testRuns: runs.slice(-LIVE_RECENT_RUNS) });
    }
    return live;
  }

  // Full runs of one session, including the code snapshots.
  async findForSession(replicationId, sessionId) {
    const events = await EventRepository.findBySession(sessionId, replicationId, {
      type: TEST_RUN,
      withContent: true,
    });
    return events.map((event) => toTestRun(event, { withCode: true }));
  }

  // One row per test run. Driven by the non-test session list, and without
  // the sessions that declined data usage, like the conversations export.
  async getReplicationCSV(replicationId) {
    const [replication, storedSessions, events] = await Promise.all([
      ReplicationRepository.findById(replicationId),
      SessionRepository.findByReplicationWithUser(replicationId),
      EventRepository.findByReplication(replicationId, { type: TEST_RUN, withContent: true }),
    ]);
    const sessions = storedSessions.filter((session) => session.dataUsage?.consentStatus !== 'declined');
    const stages = replication?.experiment?.stages || [];
    const stageIndexById = new Map(stages.map(({ id }, index) => [id, index]));
    const bySession = groupBySession(events.map((event) => toTestRun(event, { withCode: true })));

    let csv = csvRow(TEST_RUNS_CSV_HEADER);
    for (const session of sessions) {
      const sessionRuns = bySession.get(String(session.id)) || [];
      const user = session.user?.email || session.user?.id || 'Anonymous';
      const stageIndex =
        typeof session.stageIndex === 'number'
          ? session.stageIndex
          : session.stageId && stageIndexById.has(session.stageId)
            ? stageIndexById.get(session.stageId)
            : null;
      const stage = stageIndex === null ? '' : `${stageIndex + 1}/${stages.length || stageIndex + 1}`;

      sessionRuns.forEach((run, index) => {
        const failedTests = run.results
          .filter((result) => !result.ok)
          .map((result) => result.name)
          .join('; ');

        csv += csvRow([
          session.id,
          session.run ? String(session.run) : '',
          stage,
          user,
          run.id,
          index + 1,
          toIso(run.createdAt),
          run.trigger,
          run.language,
          run.fnName,
          run.status,
          run.passed,
          run.failed,
          run.total,
          run.durationMs,
          run.error || '',
          failedTests,
          JSON.stringify(run.results),
          toIso(run.reportedToLeiaAt),
          run.codeTruncated ? 'TRUE' : 'FALSE',
          run.code || '',
        ]);
      });
    }

    return csv;
  }
}

export default new TestRunService();
