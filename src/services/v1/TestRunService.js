import TestRunRepository from '../../repositories/v1/TestRunRepository.js';
import SessionRepository from '../../repositories/v1/SessionRepository.js';
import ReplicationRepository from '../../repositories/v1/ReplicationRepository.js';
import { emitToReplication } from '../../socket/index.js';
import { buildTestRunNote } from '../../utils/testRunNote.js';
import { csvRow } from '../../utils/csv.js';
import logger from '../../utils/logger.js';

// Upper bound of stored runs per session. The endpoint is unauthenticated
// (the session id is the credential), so this caps what one session can write.
export const MAX_RUNS_PER_SESSION = 300;

// How many pending runs are loaded to build the LEIA note. The note describes
// the latest one and only counts the rest.
const MAX_RUNS_IN_NOTE = 20;

// How many recent runs the live dashboard list carries per session.
const LIVE_RECENT_RUNS = 5;

export const TEST_RUNS_CSV_HEADER = [
  'Session ID',
  'User',
  'Run ID',
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

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const toIso = (value) => (value ? new Date(value).toISOString() : '');

// Widgets live in the problem definition; LEIAs configured before that
// migration carry them in the runner's luke configuration (same dual-read as
// InteractionService.getSessionData).
export function hasCodeEditorWidget(leia) {
  const problemWidgets = leia?.leia?.spec?.problem?.spec?.widgets;
  const legacyWidgets = leia?.runnerConfiguration?.lukeConfig?.widgets;
  const widgets =
    Array.isArray(problemWidgets) && problemWidgets.length > 0
      ? problemWidgets
      : Array.isArray(legacyWidgets)
        ? legacyWidgets
        : [];
  return widgets.some((widget) => widget?.widgetType === 'codeEditor');
}

// Counters and status come from the per-test results, never from the client.
export function deriveOutcome(results, error) {
  const list = Array.isArray(results) ? results : [];
  const passed = list.filter((result) => result.ok === true).length;
  const total = list.length;
  const failed = total - passed;
  const status = error ? 'error' : failed > 0 ? 'failed' : 'passed';
  return { passed, failed, total, status };
}

// A run without its code snapshot, as plain JSON.
export function toSummary(run) {
  const data = run && typeof run.toJSON === 'function' ? run.toJSON() : { ...run };
  delete data.code;
  return data;
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
   * Stores a test run reported by the code editor widget.
   * @returns {Promise<{ run: object, created: boolean }>}
   */
  async record(sessionId, payload) {
    const session = await SessionRepository.findById(sessionId);
    if (!session) throw httpError('Session not found', 404);
    if (session.finishedAt) throw httpError('Session is already finished', 403);

    const leia = await ReplicationRepository.findLeia(session.replication, session.leia);
    if (!hasCodeEditorWidget(leia)) {
      throw httpError('This activity has no code editor', 409);
    }

    if (payload.clientRunId) {
      const existing = await TestRunRepository.findBySessionAndClientRunId(session.id, payload.clientRunId);
      if (existing) return { run: existing, created: false };
    }

    const storedRuns = await TestRunRepository.countBySession(session.id);
    if (storedRuns >= MAX_RUNS_PER_SESSION) {
      throw httpError('Too many test runs for this session', 429);
    }

    const results = (payload.results || []).map((result) => ({
      name: result.name || '',
      ok: result.ok === true,
      ...(result.error ? { error: result.error } : {}),
      ...(result.expected !== undefined && result.expected !== null ? { expected: result.expected } : {}),
      ...(result.actual !== undefined && result.actual !== null ? { actual: result.actual } : {}),
    }));
    const error = payload.error || null;

    let run;
    try {
      run = await TestRunRepository.create({
        session: session.id,
        replication: session.replication,
        trigger: payload.trigger,
        language: payload.language,
        fnName: payload.fnName || '',
        code: payload.code ?? '',
        codeTruncated: payload.codeTruncated === true,
        ...deriveOutcome(results, error),
        results,
        error,
        durationMs: payload.durationMs || 0,
        clientRunAt: payload.clientRunAt,
        clientRunId: payload.clientRunId,
      });
    } catch (err) {
      // Two reports of the same run raced past the lookup above.
      if (err?.code === 11000 && payload.clientRunId) {
        const existing = await TestRunRepository.findBySessionAndClientRunId(session.id, payload.clientRunId);
        if (existing) return { run: existing, created: false };
      }
      throw err;
    }

    // Test sessions are hidden from the monitoring views, so nothing is pushed.
    if (!session.isTest) {
      try {
        // Whole dashboard room (like session:message), not admins only: owners
        // without the admin role join with a share token. No code in the event.
        emitToReplication(String(session.replication), 'session:testRun', {
          sessionId: String(session.id),
          testRun: toSummary(run),
          testRunCount: storedRuns + 1,
        });
      } catch (err) {
        logger.warn(`Failed to emit test run via WebSocket: ${err.message}`);
      }
    }

    return { run, created: true };
  }

  async markReported(sessionId, upTo) {
    return await TestRunRepository.markStudentRunsReported(sessionId, upTo);
  }

  // READ METHODS

  /**
   * Hidden context for the LEIA about student-triggered runs it has not seen.
   * @returns {Promise<{ context: string, upTo: Date } | null>} `upTo` is the
   *   time of the latest run described, to stamp once the runner confirms.
   */
  async pendingNote(sessionId, now = new Date()) {
    const runs = await TestRunRepository.findUnreportedStudentRuns(sessionId, MAX_RUNS_IN_NOTE);
    if (runs.length === 0) return null;

    const totalCount =
      runs.length < MAX_RUNS_IN_NOTE ? runs.length : await TestRunRepository.countUnreportedStudentRuns(sessionId);
    const context = buildTestRunNote(runs, { now, totalCount });
    if (!context) return null;

    return { context, upTo: runs[runs.length - 1].createdAt };
  }

  // Map of session id -> run summaries (no code), chronological.
  async summariesBySession(replicationId) {
    const runs = await TestRunRepository.findSummariesByReplication(replicationId);
    return groupBySession(runs.map(toSummary));
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
    return await TestRunRepository.findBySessionAndReplication(sessionId, replicationId);
  }

  // One row per test run. Driven by the non-test session list, so runs of
  // test sessions never reach the export.
  async getReplicationCSV(replicationId) {
    const sessions = await SessionRepository.findByReplicationWithUser(replicationId);
    const runs = await TestRunRepository.findByReplication(replicationId);
    const bySession = groupBySession(runs);

    let csv = csvRow(TEST_RUNS_CSV_HEADER);
    for (const session of sessions) {
      const sessionRuns = bySession.get(String(session.id)) || [];
      const user = session.user?.email || session.user?.id || 'Anonymous';

      sessionRuns.forEach((run, index) => {
        const results = Array.isArray(run.results) ? run.results : [];
        const plainResults = results.map((result) => ({
          name: result.name,
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
          ...(result.expected !== undefined ? { expected: result.expected } : {}),
          ...(result.actual !== undefined ? { actual: result.actual } : {}),
        }));
        const failedTests = plainResults
          .filter((result) => !result.ok)
          .map((result) => result.name)
          .join('; ');

        csv += csvRow([
          session.id,
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
          JSON.stringify(plainResults),
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
