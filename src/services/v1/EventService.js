import EventRepository from '../../repositories/v1/EventRepository.js';
import SessionRepository from '../../repositories/v1/SessionRepository.js';
import ReplicationRepository from '../../repositories/v1/ReplicationRepository.js';
import { emitToReplication } from '../../socket/index.js';
import { validateEvent } from '../../validators/v1/eventValidator.js';
import { MAX_EVENTS_PER_SESSION, getEventType } from '../../utils/eventTypes.js';
import { assertConsentDecided } from '../../utils/dataUsage.js';
import { csvRow } from '../../utils/csv.js';
import { toTestRun } from '../../utils/testRunView.js';
import logger from '../../utils/logger.js';

// The tail of the client queue may arrive just after the session finished
// (the last batch races with the finish request). Such events are kept only
// if they happened before the end and arrive within this window.
const FINISHED_GRACE_MS = 15000;

export const EVENTS_CSV_HEADER = [
  'Session ID',
  'Run ID',
  'Stage',
  'User',
  'Event ID',
  'Event Number',
  'Timestamp',
  'Received At',
  'Client Timestamp',
  'Type',
  'Source',
  'View',
  'Actor',
  'Method',
  'Origin',
  'Matched Event ID',
  'Matched Source',
  'Length',
  'Lines',
  'Truncated',
  'Hash',
  'Away Ms',
  'Reason',
  'Status',
  'Passed',
  'Failed',
  'Total',
  'Duration Ms',
  'Reported To LEIA At',
  'Text',
  'Payload JSON',
];

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const toIso = (value) => (value ? new Date(value).toISOString() : '');

// An event without its heavy content, as plain JSON: what lists, the live
// feed and anything that is not an explicit detail request may carry.
export function toSummary(event) {
  const data = event && typeof event.toJSON === 'function' ? event.toJSON() : { ...event };
  delete data.content;
  return data;
}

// Students who declined data usage are not observed: only what the activity
// itself needs is kept for them.
function hasDeclinedConsent(session) {
  return (
    !session.isTest &&
    session.dataUsage?.config?.dataUsageConsentRequired === true &&
    session.dataUsage?.consentStatus === 'declined'
  );
}

// Places a client timestamp on the server clock. The client says when the
// event happened and when it sent the batch, both on its own clock; their
// difference is the age of the event, which is subtracted from the time of
// reception. Clamped to the life of the session so far.
function eventTime(clientAt, sentAt, receivedAt, session) {
  const received = receivedAt.getTime();
  const sent = sentAt ? new Date(sentAt).getTime() : NaN;
  const happened = new Date(clientAt).getTime();
  if (!Number.isFinite(sent) || !Number.isFinite(happened)) return receivedAt;
  const started = session.startedAt ? new Date(session.startedAt).getTime() : -Infinity;
  const at = Math.min(received, Math.max(started, received - (sent - happened)));
  return new Date(at);
}

// Stage label as the conversations export writes it ("2/3"), or ''.
function stageLabel(session, stages, stageIndexById) {
  const index =
    typeof session.stageIndex === 'number'
      ? session.stageIndex
      : session.stageId && stageIndexById.has(session.stageId)
        ? stageIndexById.get(session.stageId)
        : null;
  return index === null ? '' : `${index + 1}/${stages.length || index + 1}`;
}

class EventService {
  // WRITE METHODS

  /**
   * Stores a batch of events reported by the student's browser. Each event
   * gets its own outcome, so one that cannot be stored never fails the rest:
   *   stored | duplicate | skipped (not recorded by design) | rejected.
   *
   * @param {string} sessionId
   * @param {{ sentAt?: Date|string, events: object[] }} batch
   * @param {object} [options]
   * @param {Date} [options.now]
   * @param {number} [options.finishedGraceMs] - 0 = nothing after the session ends.
   * @returns {Promise<{ results: object[], stored: object[] }>} `stored` holds
   *   the created documents (with content) for callers in this process.
   */
  async recordBatch(sessionId, batch, { now = new Date(), finishedGraceMs = FINISHED_GRACE_MS } = {}) {
    const session = await SessionRepository.findById(sessionId);
    if (!session) throw httpError('Session not found', 404);
    assertConsentDecided(session);

    const rawEvents = Array.isArray(batch?.events) ? batch.events : [];
    const validated = rawEvents.map(validateEvent);
    const candidates = validated.filter((entry) => entry.event).map((entry) => entry.event);

    const [counts, known] = await Promise.all([
      EventRepository.countsByTypeForSession(session.id),
      EventRepository.findByClientEventIds(
        session.id,
        candidates.map((event) => event.clientEventId)
      ),
    ]);
    const knownById = new Map(known.map((event) => [event.clientEventId, event]));
    let total = Object.values(counts).reduce((sum, count) => sum + count, 0);

    // Only loaded when a type in the batch needs to look at the activity.
    let leia;
    const loadLeia = async () => {
      if (leia === undefined) {
        leia = (await ReplicationRepository.findLeia(session.replication, session.leia)) || null;
      }
      return leia;
    };

    const declined = hasDeclinedConsent(session);
    const finishedAt = session.finishedAt ? new Date(session.finishedAt).getTime() : null;
    const seenInBatch = new Set();
    const results = [];
    const stored = [];

    for (const entry of validated) {
      if (entry.rejected) {
        results.push({ clientEventId: entry.clientEventId, status: 'rejected', ...entry.rejected });
        continue;
      }
      const event = entry.event;
      const { clientEventId } = event;
      const definition = getEventType(event.type);

      const previous = knownById.get(clientEventId);
      if (previous || seenInBatch.has(clientEventId)) {
        results.push({
          clientEventId,
          status: 'duplicate',
          ...(previous ? { id: String(previous.id), at: previous.at } : {}),
        });
        continue;
      }
      seenInBatch.add(clientEventId);

      if (definition.consent === 'observational' && (declined || session.isTest)) {
        results.push({ clientEventId, status: 'skipped', reason: declined ? 'consent_declined' : 'test_session' });
        continue;
      }

      const at = eventTime(event.clientAt, batch?.sentAt, now, session);
      if (finishedAt !== null) {
        const inGrace =
          finishedGraceMs > 0 && at.getTime() <= finishedAt && now.getTime() - finishedAt <= finishedGraceMs;
        if (!inGrace) {
          results.push({ clientEventId, status: 'rejected', reason: 'session_finished' });
          continue;
        }
      }

      if (definition.guard) {
        const reason = definition.guard({ session, leia: definition.needsLeia ? await loadLeia() : null });
        if (reason) {
          results.push({ clientEventId, status: 'rejected', reason });
          continue;
        }
      }

      if ((counts[event.type] || 0) >= definition.cap || total >= MAX_EVENTS_PER_SESSION) {
        results.push({ clientEventId, status: 'rejected', reason: 'cap_reached' });
        continue;
      }

      let created;
      try {
        created = await EventRepository.create({
          session: session.id,
          replication: session.replication,
          run: session.run,
          stageId: session.stageId,
          stageIndex: session.stageIndex,
          type: event.type,
          source: event.source,
          actor: event.actor,
          view: event.view,
          payload: event.payload,
          content: event.content,
          hasContent: typeof event.content === 'string' && event.content.length > 0,
          contentTruncated: event.contentTruncated,
          clientEventId,
          clientAt: event.clientAt,
          seq: event.seq,
          at,
        });
      } catch (err) {
        // The same event raced in through another request.
        if (err?.code === 11000) {
          results.push({ clientEventId, status: 'duplicate' });
          continue;
        }
        throw err;
      }

      counts[event.type] = (counts[event.type] || 0) + 1;
      total += 1;
      stored.push(created);
      results.push({ clientEventId, status: 'stored', id: String(created.id), at: created.at });
    }

    // Test sessions are hidden from the monitoring views, so nothing is pushed.
    if (stored.length > 0 && !session.isTest) {
      this.emitStored(session, stored, counts);
    }

    return { results, stored };
  }

  // One update per batch for the whole dashboard room (like session:message),
  // not admins only: owners without the admin role join with a share token.
  // Summaries only, never content.
  emitStored(session, stored, counts) {
    const replicationId = String(session.replication);
    const sessionId = String(session.id);
    try {
      emitToReplication(replicationId, 'session:events', {
        sessionId,
        events: stored.map(toSummary),
        counts,
      });
      // Until the dashboard reads session:events, test runs keep their own event.
      for (const event of stored.filter((entry) => entry.type === 'test_run')) {
        emitToReplication(replicationId, 'session:testRun', {
          sessionId,
          testRun: toTestRun(event),
          testRunCount: counts.test_run,
        });
      }
    } catch (err) {
      logger.warn(`Failed to emit events via WebSocket: ${err.message}`);
    }
  }

  async deleteForSession(sessionId) {
    return await EventRepository.deleteBySession(sessionId);
  }

  // READ METHODS

  // Map of session id -> { type: count }.
  async countsBySession(replicationId) {
    const rows = await EventRepository.countsByReplication(replicationId);
    const bySession = new Map();
    for (const row of rows) {
      if (!bySession.has(row.session)) bySession.set(row.session, {});
      bySession.get(row.session)[row.type] = row.count;
    }
    return bySession;
  }

  // Adds `eventCounts` to each session of a replication. Lists carry counts
  // only; the events of a session are loaded when it is opened.
  async attachCounts(replicationId, sessions) {
    const bySession = await this.countsBySession(replicationId);
    return sessions.map((session) => {
      const data = session && typeof session.toJSON === 'function' ? session.toJSON() : { ...session };
      return { ...data, eventCounts: bySession.get(String(data.id)) || {} };
    });
  }

  // Timeline of one session, without content.
  async findForSession(replicationId, sessionId) {
    const events = await EventRepository.findBySession(sessionId, replicationId);
    return events.map(toSummary);
  }

  // One event with its content (code or clipboard text).
  async findOne(replicationId, sessionId, eventId) {
    const event = await EventRepository.findOneWithContent(eventId, sessionId, replicationId);
    if (!event) throw httpError('Event not found', 404);
    const data = event.toJSON();
    return { ...data, content: data.content ?? '' };
  }

  // One row per event. Driven by the non-test session list, and without the
  // sessions that declined data usage, like the conversations export. Clipboard
  // text goes in `Text`; the code of a test run stays in the test-runs export.
  async getReplicationCSV(replicationId) {
    const [replication, storedSessions, events] = await Promise.all([
      ReplicationRepository.findById(replicationId),
      SessionRepository.findByReplicationWithUser(replicationId),
      EventRepository.findByReplication(replicationId, { withContent: true }),
    ]);
    const sessions = storedSessions.filter((session) => session.dataUsage?.consentStatus !== 'declined');
    const stages = replication?.experiment?.stages || [];
    const stageIndexById = new Map(stages.map(({ id }, index) => [id, index]));

    const bySession = new Map();
    for (const event of events) {
      const key = String(event.session);
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key).push(event);
    }

    let csv = csvRow(EVENTS_CSV_HEADER);
    for (const session of sessions) {
      const user = session.user?.email || session.user?.id || 'Anonymous';
      const runId = session.run ? String(session.run) : '';
      const stage = stageLabel(session, stages, stageIndexById);

      (bySession.get(String(session.id)) || []).forEach((event, index) => {
        const payload = event.payload || {};
        const isClipboard = event.type.startsWith('clipboard_');
        csv += csvRow([
          session.id,
          runId,
          stage,
          user,
          event.id,
          index + 1,
          toIso(event.at),
          toIso(event.createdAt),
          toIso(event.clientAt),
          event.type,
          event.source,
          event.view || '',
          event.actor,
          payload.method ?? '',
          payload.origin ?? '',
          payload.match?.clientEventId ?? '',
          payload.match?.source ?? '',
          payload.length ?? '',
          payload.lines ?? '',
          event.hasContent ? (event.contentTruncated ? 'TRUE' : 'FALSE') : '',
          payload.hash ?? '',
          payload.awayMs ?? '',
          payload.reason ?? '',
          payload.status ?? '',
          payload.passed ?? '',
          payload.failed ?? '',
          payload.total ?? '',
          payload.durationMs ?? '',
          toIso(event.reportedToLeiaAt),
          isClipboard ? event.content || '' : '',
          JSON.stringify(payload),
        ]);
      });
    }

    return csv;
  }
}

export default new EventService();
