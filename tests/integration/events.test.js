import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import express from 'express';
import mongoose from 'mongoose';
import Replication from '../../src/models/Replication.js';
import ActivityRun from '../../src/models/ActivityRun.js';
import Session from '../../src/models/Session.js';
import Message from '../../src/models/Message.js';
import Event from '../../src/models/Event.js';
import replicationRoutes from '../../src/routes/v1/replicationRoutes.js';
import interactionRoutes from '../../src/routes/v1/interactionRoutes.js';
import spectatorRoutes from '../../src/routes/v1/spectatorRoutes.js';
import { auth } from '../../src/middlewares/auth.js';
import errorHandler from '../../src/middlewares/errorHandler.js';
import { EVENTS_BODY_PATH, eventsBodyParser } from '../../src/middlewares/eventsBodyParser.js';
import { processConversationRemoval } from '../../src/services/v1/ConversationRemovalService.js';
import { migrateTestRunsToEvents } from '../../scripts/migrate-test-runs-to-events.js';
import { connectMongo, closeMongo, listen } from './support.js';

let http, peers, replication, other, consentReplication;
const leiaConfigId = new mongoose.Types.ObjectId();
const stages = [{ id: 'stage-one' }, { id: 'stage-two' }];
const experiment = () => ({ id: new mongoose.Types.ObjectId().toString(), stages, leias: [{
  id: leiaConfigId, stageId: 'stage-one', sessionCount: 0, configuration: { mode: 'standard' },
  runnerConfiguration: { provider: 'openai-responses', modelName: 'fixture-model' },
  leia: { id: new mongoose.Types.ObjectId().toString(), metadata: { name: 'Code tutor' }, spec: {
    problem: { spec: { solution: 'Private solution', widgets: [{ widgetType: 'codeEditor', slot: 'right', params: {} }] } },
    behaviour: { spec: { description: 'Private instructions' } },
  } },
}] });
const request = (path, method = 'GET', body) => fetch(`${http.url}/api/v1${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
});
const id = () => new mongoose.Types.ObjectId().toString();
const paste = (overrides = {}) => ({
  clientEventId: id(), type: 'clipboard_paste', source: 'code_editor', view: 'chat',
  clientAt: new Date().toISOString(), seq: 1,
  payload: { method: 'keyboard', origin: 'external', clipboardTypes: ['text/plain', 'text/html'] },
  content: 'function twoSum(nums, target) {\r\n  return "a, b";\r\n}',
  ...overrides,
});
const testRun = (overrides = {}) => ({
  clientEventId: id(), type: 'test_run', source: 'code_editor', actor: 'student', view: 'chat',
  clientAt: new Date().toISOString(),
  payload: { language: 'javascript', fnName: 'twoSum', results: [{ name: 'basic', ok: true }, { name: 'empty list', ok: false, expected: '[]', actual: 'undefined' }], durationMs: 12 },
  content: 'function twoSum() {}',
  ...overrides,
});
const pageLeave = () => ({ clientEventId: id(), type: 'page_leave', source: 'page', clientAt: new Date().toISOString(), payload: { reason: 'hidden' } });
const pageReturn = () => ({ clientEventId: id(), type: 'page_return', source: 'page', clientAt: new Date().toISOString(), payload: { awayMs: 42000, reason: 'hidden', becameHidden: true } });
const send = (sessionId, events) => request(`/interactions/${sessionId}/events`, 'POST', { sentAt: new Date().toISOString(), events });
// A session of an activity run, placed in a stage, as the staged model creates them.
const stagedSession = async (replicationId, overrides = {}) => {
  // Only one open run per user and replication is allowed, so each gets its own user.
  const run = await ActivityRun.create({ replication: replicationId, user: new mongoose.Types.ObjectId() });
  return Session.create({ replication: replicationId, leia: leiaConfigId, run: run.id, stageId: 'stage-two', stageIndex: 1, ...overrides });
};

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', 'integration-signing-secret'); vi.stubEnv('JWT_ISSUER', ''); vi.stubEnv('JWT_AUDIENCE', '');
  vi.stubEnv('RUNNER_KEY', 'integration-runner');
  vi.stubEnv('FRONTEND_URL', 'https://pre.workbench.leia.ovh');
  await connectMongo(); await Replication.init(); await Event.init();
  const peer = express(); peer.use(express.json());
  peer.delete('/api/v1/cache/purge', (_req, res) => res.json({ success: true }));
  peer.delete('/api/v1/leias/:id/traces', (_req, res) => res.json({ complete: true }));
  peer.post('/api/v1/supervisor', (_req, res) => res.json({ flags: [] }));
  peers = await listen(peer);
  for (const key of ['AUTH_URL', 'MANAGER_URL', 'RUNNER_URL']) vi.stubEnv(key, peers.url);
  // Same order as src/index.js: the events parser before the global one.
  const app = express(); app.use(EVENTS_BODY_PATH, eventsBodyParser); app.use(express.json(), auth);
  app.use('/api/v1/replications', replicationRoutes); app.use('/api/v1/interactions', interactionRoutes);
  app.use('/api/v1/spectator', spectatorRoutes); app.use(errorHandler);
  http = await listen(app);
  replication = await Replication.create({ name: 'Events integration', code: 'REVT01', isActive: true, isShared: true, shareToken: 'share-events', experiment: experiment() });
  other = await Replication.create({ name: 'Other events integration', code: 'REVT02', isActive: true, isShared: true, shareToken: 'share-other', experiment: experiment() });
  consentReplication = await Replication.create({
    name: 'Consent events integration', code: 'REVT03', isActive: true, isShared: true, shareToken: 'share-consent', experiment: experiment(),
  });
});
afterAll(async () => { await http?.close(); await peers?.close(); await closeMongo(); vi.unstubAllEnvs(); });

test('a batch stores each event once in the events collection, with its own outcome and server-derived fields', async () => {
  const session = await stagedSession(replication.id);
  const sent = paste();
  const run = testRun({ payload: { ...testRun().payload, passed: 50, status: 'passed' } });
  const response = await send(session.id, [sent, run, pageLeave(), { ...paste(), source: 'page' }, { ...paste(), type: 'keystroke' }]);
  expect(response.status).toBe(200);
  const { results } = await response.json();
  expect(results.map(({ status, reason }) => [status, reason])).toEqual([
    ['stored', undefined], ['stored', undefined], ['stored', undefined], ['rejected', 'validation'], ['rejected', 'unknown_type'],
  ]);
  // A retried batch is acknowledged without new documents.
  const retried = await (await send(session.id, [sent, run])).json();
  expect(retried.results.map(({ status, id: eventId }) => [status, eventId])).toEqual([
    ['duplicate', results[0].id], ['duplicate', results[1].id],
  ]);
  expect(await Event.countDocuments({ session: session.id })).toBe(3);

  const stored = await Event.findById(results[0].id).select('+content');
  expect(stored).toMatchObject({ type: 'clipboard_paste', source: 'code_editor', actor: 'student', view: 'chat', stageId: 'stage-two', stageIndex: 1, hasContent: true });
  expect(String(stored.run)).toBe(String(session.run));
  expect(String(stored.replication)).toBe(replication.id);
  expect(stored.content).toBe(sent.content);
  expect(stored.payload).toMatchObject({ method: 'keyboard', origin: 'external', length: sent.content.length, lines: 3, clipboardTypes: ['text/plain', 'text/html'] });
  expect(stored.payload.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(stored.at.getTime()).toBeLessThanOrEqual(Date.now());
  // Content is never part of a default read.
  expect((await Event.findById(results[0].id)).content).toBeUndefined();
  expect((await Event.findById(results[1].id)).payload).toMatchObject({ passed: 1, failed: 1, total: 2, status: 'failed' });

  expect((await send(new mongoose.Types.ObjectId(), [paste()])).status).toBe(404);
  expect((await request(`/interactions/${session.id}/events`, 'POST', { events: [] })).status).toBe(400);
});

test('the events route accepts bodies above the global limit, up to its own', async () => {
  const session = await stagedSession(replication.id);
  const big = (size) => Array.from({ length: 6 }, () => paste({ content: 'x'.repeat(size) }));
  const accepted = await send(session.id, big(50000));
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).results.every(({ status }) => status === 'stored')).toBe(true);
  expect((await send(session.id, big(100000))).status).toBe(413);
  // Text over the per-event limit is cut and flagged, keeping the original length.
  const long = paste({ content: 'y'.repeat(70000), payload: { method: 'keyboard', length: 70000 } });
  const { results } = await (await send(session.id, [long])).json();
  const stored = await Event.findById(results[0].id).select('+content');
  expect(stored.content).toHaveLength(60000);
  expect(stored).toMatchObject({ contentTruncated: true, payload: { length: 70000 } });
});

test('consent decides what is recorded, and removal deletes it with the conversation', async () => {
  await Replication.updateOne({ _id: consentReplication.id }, { $set: { dataUsageConfig: {
    dataUsageConsentRequired: true, dataUsageConsentMessage: 'Choose.', conversationAutomatedRemoval: true,
  } } });
  const usage = (consentStatus) => ({
    config: { dataUsageConsentRequired: true, dataUsageConsentMessage: 'Choose.', conversationAutomatedRemoval: true },
    consentStatus, decidedAt: null, automatedRemovalApplied: false,
  });
  const pending = await Session.create({ replication: consentReplication.id, leia: leiaConfigId, dataUsage: usage('pending') });
  expect((await send(pending.id, [paste(), testRun()])).status).toBe(403);
  expect(await Event.countDocuments({ session: pending.id })).toBe(0);

  // The decision is taken through the real endpoint.
  expect((await request(`/interactions/${pending.id}/data-usage-consent`, 'POST', { accepted: false })).status).toBe(200);
  const declined = pending.id;
  const declinedResults = (await (await send(declined, [paste(), pageLeave(), testRun()])).json()).results;
  expect(declinedResults.map(({ status, reason }) => [status, reason])).toEqual([
    ['skipped', 'consent_declined'], ['skipped', 'consent_declined'], ['stored', undefined],
  ]);
  const accepted = await Session.create({ replication: consentReplication.id, leia: leiaConfigId, dataUsage: usage('accepted') });
  expect((await (await send(accepted.id, [paste(), testRun()])).json()).results.every(({ status }) => status === 'stored')).toBe(true);

  // Exports leave out the session that declined, like the conversations export.
  const eventsCsv = await (await request(`/replications/${consentReplication.id}/events/csv?token=share-consent`)).text();
  const testRunsCsv = await (await request(`/replications/${consentReplication.id}/test-runs/csv?token=share-consent`)).text();
  for (const csv of [eventsCsv, testRunsCsv]) {
    expect(csv).toContain(accepted.id);
    expect(csv).not.toContain(declined);
  }

  // Finishing schedules the removal; once it runs, the events are gone too.
  await Message.create({ session: declined, text: 'Synthetic message', isLeia: false });
  expect((await request(`/interactions/${declined}/finish`, 'POST', {})).status).toBe(200);
  const due = (await Session.findById(declined).select('+conversationRemovalDueAt')).conversationRemovalDueAt;
  expect(due).toBeInstanceOf(Date);
  expect(await Event.countDocuments({ session: declined })).toBe(1);
  expect(await processConversationRemoval(new Date(due.getTime() + 1000))).toBe(true);
  expect(await Event.countDocuments({ session: declined })).toBe(0);
  expect(await Message.countDocuments({ session: declined })).toBe(0);
  expect(await Event.countDocuments({ session: accepted.id })).toBe(2);
});

test('a finished session only takes the tail of the queue; test sessions are not observed', async () => {
  const session = await stagedSession(replication.id);
  const before = new Date(Date.now() - 2000).toISOString();
  expect((await request(`/interactions/${session.id}/finish`, 'POST', {})).status).toBe(200);
  const { results } = await (await send(session.id, [paste({ clientAt: before }), paste()])).json();
  expect(results.map(({ status, reason }) => [status, reason])).toEqual([
    ['stored', undefined], ['rejected', 'session_finished'],
  ]);

  const testSession = await Session.create({ replication: replication.id, leia: leiaConfigId, isTest: true });
  const tested = (await (await send(testSession.id, [paste({ content: 'hidden test session text' }), testRun()])).json()).results;
  expect(tested.map(({ status, reason }) => [status, reason])).toEqual([['skipped', 'test_session'], ['stored', undefined]]);
});

test('test runs stored before the events collection are migrated once and read like any other', async () => {
  const session = await stagedSession(replication.id);
  const createdAt = new Date(Date.now() - 60000);
  const legacy = {
    _id: new mongoose.Types.ObjectId(), session: session._id, replication: new mongoose.Types.ObjectId(replication.id),
    trigger: 'student', language: 'javascript', fnName: 'twoSum', code: 'function legacy() {}', codeTruncated: false,
    status: 'failed', passed: 1, failed: 1, total: 2, results: [{ name: 'basic', ok: true }, { name: 'empty list', ok: false }],
    error: null, durationMs: 9, clientRunId: 'legacy-client-id', reportedToLeiaAt: null, createdAt,
  };
  const db = mongoose.connection.db;
  await db.collection('testruns').insertOne(legacy);

  // A dry run reports and writes nothing.
  expect(await migrateTestRunsToEvents(db)).toEqual({ found: 1, migrated: 1, alreadyThere: 0 });
  expect(await Event.countDocuments({ session: session.id })).toBe(0);
  expect(await migrateTestRunsToEvents(db, { apply: true })).toEqual({ found: 1, migrated: 1, alreadyThere: 0 });
  expect(await migrateTestRunsToEvents(db, { apply: true })).toEqual({ found: 1, migrated: 0, alreadyThere: 1 });

  const event = await Event.findById(legacy._id).select('+content');
  expect(event).toMatchObject({ type: 'test_run', source: 'code_editor', actor: 'student', stageId: 'stage-two', content: 'function legacy() {}', clientEventId: 'legacy-client-id' });
  expect(event.at).toEqual(createdAt);
  const runs = await (await request(`/replications/${replication.id}/sessions/${session.id}/test-runs?token=share-events`)).json();
  expect(runs.testRuns).toHaveLength(1);
  expect(runs.testRuns[0]).toMatchObject({ id: String(legacy._id), trigger: 'student', status: 'failed', code: 'function legacy() {}' });
  // The same run reported again by a client that kept its id is not stored twice.
  const repeated = await request(`/interactions/${session.id}/test-runs`, 'POST', {
    clientRunId: 'legacy-client-id', trigger: 'student', language: 'javascript', code: 'function legacy() {}', results: [{ name: 'basic', ok: true }],
  });
  expect(repeated.status).toBe(200);
  expect(await Event.countDocuments({ session: session.id })).toBe(1);
});

test('instructors get counts in lists, a session timeline without content, content on demand and a CSV', async () => {
  const session = await stagedSession(replication.id, { user: undefined });
  const copy = { ...paste({ content: 'const total = 1;' }), type: 'clipboard_copy', payload: { method: 'menu' } };
  const pasted = paste({ payload: { method: 'keyboard', origin: 'internal', match: { clientEventId: copy.clientEventId, source: 'code_editor', kind: 'exact', ageMs: 900 } }, content: 'const total = 1;' });
  // As a real client sends them: a growing counter orders events of the same instant.
  const batch = [copy, pasted, pageLeave(), pageReturn(), testRun()].map((event, seq) => ({ ...event, seq }));
  await send(session.id, batch);
  const testSession = await Session.create({ replication: replication.id, leia: leiaConfigId, isTest: true });
  await send(testSession.id, [testRun({ content: 'hidden test session code' })]);

  const conversations = await (await request(`/replications/${replication.id}/conversations?token=share-events`)).json();
  const listed = conversations.find((entry) => entry.id === session.id);
  expect(listed.eventCounts).toEqual({ clipboard_copy: 1, clipboard_paste: 1, page_leave: 1, page_return: 1, test_run: 1 });
  expect(listed).not.toHaveProperty('events');
  expect(JSON.stringify(conversations)).not.toContain('const total = 1;');
  expect(JSON.stringify(conversations)).not.toContain('hidden test session code');

  const live = await (await request(`/spectator/replications/${replication.id}/sessions?token=share-events`)).json();
  expect(live.sessions.find((entry) => entry.id === session.id).eventCounts).toMatchObject({ clipboard_paste: 1, test_run: 1 });

  const timeline = await request(`/replications/${replication.id}/sessions/${session.id}/events?token=share-events`);
  expect(timeline.status).toBe(200);
  const { events, total } = await timeline.json();
  expect(total).toBe(5);
  expect(events.map(({ type }) => type)).toEqual(['clipboard_copy', 'clipboard_paste', 'page_leave', 'page_return', 'test_run']);
  expect(events.every((event) => !('content' in event))).toBe(true);
  expect(events[1]).toMatchObject({ source: 'code_editor', hasContent: true, payload: { origin: 'internal', preview: 'const total = 1;', match: { clientEventId: copy.clientEventId } } });

  const detail = await (await request(`/replications/${replication.id}/sessions/${session.id}/events/${events[1].id}?token=share-events`)).json();
  expect(detail.event).toMatchObject({ id: events[1].id, type: 'clipboard_paste', content: 'const total = 1;' });
  const code = await (await request(`/replications/${replication.id}/sessions/${session.id}/events/${events[4].id}?token=share-events`)).json();
  expect(code.event.content).toBe('function twoSum() {}');

  // Access to one replication does not open another replication's session or event.
  const crossed = await (await request(`/replications/${other.id}/sessions/${session.id}/events?token=share-other`)).json();
  expect(crossed).toEqual({ events: [], total: 0 });
  expect((await request(`/replications/${other.id}/sessions/${session.id}/events/${events[1].id}?token=share-other`)).status).toBe(404);
  expect((await request(`/replications/${replication.id}/sessions/${session.id}/events?token=share-other`)).status).toBe(403);
  expect((await request(`/replications/${replication.id}/sessions/${session.id}/events`)).status).toBe(403);

  const csvResponse = await request(`/replications/${replication.id}/events/csv?token=share-events`);
  expect(csvResponse.headers.get('content-disposition')).toContain('Events_integration_events.csv');
  const csv = await csvResponse.text();
  expect(csv.split('\n')[0]).toBe(
    'Session ID,Run ID,Stage,User,Event ID,Event Number,Timestamp,Received At,Client Timestamp,Type,Source,View,Actor,Method,Origin,Matched Event ID,Matched Source,Length,Lines,Truncated,Hash,Away Ms,Reason,Status,Passed,Failed,Total,Duration Ms,Reported To LEIA At,Text,Payload JSON'
  );
  expect(csv).toContain(`${session.id},${session.run},2/2,Anonymous,${events[1].id},2,`);
  expect(csv).toContain(`,clipboard_paste,code_editor,chat,student,keyboard,internal,${copy.clientEventId},code_editor,16,1,FALSE,`);
  expect(csv).toContain(',page_return,page,,student,,,,,,,,,42000,hidden,');
  expect(csv).toContain(',test_run,code_editor,chat,student,,,,,,,FALSE,,,,failed,1,1,2,12,,,');
  // Clipboard text is exported; the code of a test run stays in the test-runs export.
  expect(csv).toContain(',const total = 1;,');
  expect(csv).not.toContain('function twoSum() {}');
  expect(csv).not.toContain('hidden test session code');

  const conversationsCsv = await (await request(`/replications/${replication.id}/conversations/csv?token=share-events`)).text();
  expect(conversationsCsv.split('\n')[0]).toBe('Session ID,Run ID,Stage,LEIA,User,Started At,Finished At,Message,Is LEIA,Sender,Timestamp,Evaluation Mode,Score,Evaluation,Submitted Solution');
  expect(conversationsCsv).not.toContain('const total');

  const studentView = await (await request(`/interactions/${session.id}`)).json();
  expect(studentView.leia.eventsEnabled).toBe(true);
  expect(JSON.stringify(studentView)).not.toContain('eventCounts');
  expect(JSON.stringify(studentView)).not.toContain('const total = 1;');
});
