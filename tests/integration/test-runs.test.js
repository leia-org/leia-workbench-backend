import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import express from 'express';
import mongoose from 'mongoose';
import Replication from '../../src/models/Replication.js';
import Session from '../../src/models/Session.js';
import Message from '../../src/models/Message.js';
import TestRun from '../../src/models/TestRun.js';
import replicationRoutes from '../../src/routes/v1/replicationRoutes.js';
import interactionRoutes from '../../src/routes/v1/interactionRoutes.js';
import spectatorRoutes from '../../src/routes/v1/spectatorRoutes.js';
import { auth } from '../../src/middlewares/auth.js';
import errorHandler from '../../src/middlewares/errorHandler.js';
import { connectMongo, closeMongo, listen } from './support.js';

let http, peers, replication, other;
const runnerMessages = [];
const leiaConfigId = new mongoose.Types.ObjectId();
const experiment = (widgets) => ({ id: new mongoose.Types.ObjectId().toString(), leias: [{
  id: leiaConfigId, sessionCount: 0, configuration: { mode: 'standard' },
  runnerConfiguration: { provider: 'openai-responses', modelName: 'fixture-model' },
  leia: { id: new mongoose.Types.ObjectId().toString(), metadata: { name: 'Code tutor' }, spec: {
    problem: { spec: { solution: 'Private solution', widgets } },
    behaviour: { spec: { description: 'Private instructions' } },
  } },
}] });
const codeEditor = [{ widgetType: 'codeEditor', slot: 'right', params: { fnName: 'twoSum', language: 'javascript', tests: [] } }];
const request = (path, method = 'GET', body) => fetch(`${http.url}/api/v1${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
});
const report = (overrides = {}) => ({
  clientRunId: new mongoose.Types.ObjectId().toString(),
  trigger: 'student', language: 'javascript', fnName: 'twoSum',
  code: 'function twoSum(nums, target) {\n  return "a, b";\n}\n',
  results: [
    { name: 'basic', ok: true },
    { name: 'empty list', ok: false, expected: '[]', actual: 'undefined' },
  ],
  durationMs: 12,
  ...overrides,
});
const join = async (email, code) => (await (await request('/interactions', 'POST', { email, code })).json()).sessionId;

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', 'integration-signing-secret'); vi.stubEnv('JWT_ISSUER', ''); vi.stubEnv('JWT_AUDIENCE', '');
  vi.stubEnv('RUNNER_KEY', 'integration-runner');
  await connectMongo(); await Replication.init(); await TestRun.init();
  const peer = express(); peer.use(express.json());
  peer.post('/api/v1/leias', (req, res) => res.status(201).json({ sessionId: req.body.sessionId }));
  // Runner contract: a context is acknowledged, unless the message asks to
  // behave like a runner that predates the field.
  peer.post('/api/v1/leias/:id/messages', (req, res) => {
    runnerMessages.push(req.body);
    const acknowledged = Boolean(req.body.context) && !req.body.message.includes('[old runner]');
    res.json({ message: `Answer: ${req.body.message}`, ...(acknowledged ? { contextApplied: true } : {}) });
  });
  peer.delete('/api/v1/cache/purge', (_req, res) => res.json({ success: true }));
  peers = await listen(peer);
  for (const key of ['AUTH_URL', 'MANAGER_URL', 'RUNNER_URL']) vi.stubEnv(key, peers.url);
  const app = express(); app.use(express.json(), auth);
  app.use('/api/v1/replications', replicationRoutes); app.use('/api/v1/interactions', interactionRoutes);
  app.use('/api/v1/spectator', spectatorRoutes); app.use(errorHandler);
  http = await listen(app);
  replication = await Replication.create({
    name: 'Coding integration', code: 'RCODE1', isActive: true, isShared: true, shareToken: 'share-coding', experiment: experiment(codeEditor),
  });
  other = await Replication.create({
    name: 'Plain integration', code: 'RPLAIN', isActive: true, isShared: true, shareToken: 'share-plain', experiment: experiment([]),
  });
});
afterAll(async () => { await http?.close(); await peers?.close(); await closeMongo(); vi.unstubAllEnvs(); });

test('a test run is stored once, with server-derived outcome, and only for activities with a code editor', async () => {
  const sessionId = await join('ingest@example.com', 'RCODE1');
  const body = report();
  const created = await request(`/interactions/${sessionId}/test-runs`, 'POST', { ...body, passed: 50, status: 'passed' });
  expect(created.status).toBe(201);
  const { id, createdAt } = await created.json();
  expect(new Date(createdAt).getTime()).not.toBeNaN();
  // A retried report of the same run is acknowledged without a second document.
  const repeated = await request(`/interactions/${sessionId}/test-runs`, 'POST', body);
  expect(repeated.status).toBe(200);
  expect((await repeated.json()).id).toBe(id);
  expect(await TestRun.countDocuments({ session: sessionId })).toBe(1);
  const stored = await TestRun.findById(id);
  expect(stored).toMatchObject({ passed: 1, failed: 1, total: 2, status: 'failed', trigger: 'student', reportedToLeiaAt: null });
  expect(stored.code).toBe(body.code);
  expect(String(stored.replication)).toBe(replication.id);

  expect((await request(`/interactions/${sessionId}/test-runs`, 'POST', { ...report(), language: 'text' })).status).toBe(400);
  expect((await request(`/interactions/${new mongoose.Types.ObjectId()}/test-runs`, 'POST', report())).status).toBe(404);
  const plainSession = await join('plain@example.com', 'RPLAIN');
  expect((await request(`/interactions/${plainSession}/test-runs`, 'POST', report())).status).toBe(409);
  await request(`/interactions/${sessionId}/finish`, 'POST', {});
  expect((await request(`/interactions/${sessionId}/test-runs`, 'POST', report())).status).toBe(403);
});

test('student-triggered runs reach the LEIA once as separate context; the stored message stays the student text', async () => {
  const sessionId = await join('note@example.com', 'RCODE1');
  await request(`/interactions/${sessionId}/test-runs`, 'POST', report());
  await request(`/interactions/${sessionId}/test-runs`, 'POST', report({ trigger: 'leia' }));

  // A runner that does not acknowledge leaves the run pending.
  await request(`/interactions/${sessionId}/messages`, 'POST', { message: 'hello [old runner]' });
  expect(runnerMessages.at(-1).context).toContain('1/2 tests passed');
  expect((await TestRun.findOne({ session: sessionId, trigger: 'student' })).reportedToLeiaAt).toBeNull();

  const sent = await request(`/interactions/${sessionId}/messages`, 'POST', { message: 'why does it fail?' });
  expect(sent.status).toBe(200);
  const delivered = runnerMessages.at(-1);
  expect(delivered.message).toBe('why does it fail?');
  expect(delivered.context).toContain('ran the test suite themself 1 time');
  expect(delivered.context).toContain('- empty list: expected [], got undefined');
  expect((await TestRun.findOne({ session: sessionId, trigger: 'student' })).reportedToLeiaAt).toBeInstanceOf(Date);
  // The LEIA's own run is never reported back to it.
  expect((await TestRun.findOne({ session: sessionId, trigger: 'leia' })).reportedToLeiaAt).toBeNull();

  await request(`/interactions/${sessionId}/messages`, 'POST', { message: 'thanks' });
  expect(runnerMessages.at(-1).context).toBeUndefined();
  const stored = await Message.find({ session: sessionId, isLeia: false });
  expect(stored.map((message) => message.text)).toEqual(['hello [old runner]', 'why does it fail?', 'thanks']);
});

test('instructors read summaries in lists, code on demand and a CSV; students and other replications see none of it', async () => {
  const sessionId = await join('reader@example.com', 'RCODE1');
  await request(`/interactions/${sessionId}/test-runs`, 'POST', report());
  await request(`/interactions/${sessionId}/test-runs`, 'POST', report({ results: [], error: 'SyntaxError: Unexpected token' }));
  // Runs of a test session stay out of every instructor view and export.
  const testSession = await Session.create({ replication: replication.id, leia: leiaConfigId, isTest: true });
  await request(`/interactions/${testSession.id}/test-runs`, 'POST', report({ code: 'hidden test session code' }));

  const conversations = await (await request(`/replications/${replication.id}/conversations?token=share-coding`)).json();
  const session = conversations.find((entry) => entry.id === sessionId);
  expect(session.testRuns.map((run) => run.status)).toEqual(['failed', 'error']);
  expect(session.testRuns.every((run) => !('code' in run))).toBe(true);
  expect(JSON.stringify(conversations)).not.toContain('hidden test session code');
  expect((await request(`/replications/${replication.id}/conversations`)).status).toBe(403);

  const detail = await request(`/replications/${replication.id}/sessions/${sessionId}/test-runs?token=share-coding`);
  expect(detail.status).toBe(200);
  expect((await detail.json()).testRuns.map((run) => run.code)).toEqual([report().code, report().code]);
  // Access to one replication does not open another replication's session.
  const crossed = await request(`/replications/${other.id}/sessions/${sessionId}/test-runs?token=share-plain`);
  expect((await crossed.json()).testRuns).toEqual([]);
  expect((await request(`/replications/${replication.id}/sessions/${sessionId}/test-runs?token=share-plain`)).status).toBe(403);

  const csvResponse = await request(`/replications/${replication.id}/test-runs/csv?token=share-coding`);
  expect(csvResponse.headers.get('content-disposition')).toContain('Coding_integration_test_runs.csv');
  const csv = await csvResponse.text();
  expect(csv.split('\n')[0]).toBe(
    'Session ID,User,Run ID,Run Number,Timestamp,Trigger,Language,Function,Status,Passed,Failed,Total,Duration Ms,Error,Failed Tests,Results JSON,Reported To LEIA At,Code Truncated,Code'
  );
  expect(csv).toContain(`${sessionId},reader@example.com,`);
  expect(csv).toContain(',failed,1,1,2,12,,empty list,');
  expect(csv).toContain(',error,0,0,0,12,SyntaxError: Unexpected token,,[],,FALSE,');
  expect(csv).toContain('"function twoSum(nums, target) {\n  return ""a, b"";\n}\n"');
  expect(csv).not.toContain('hidden test session code');
  const conversationsCsv = await (await request(`/replications/${replication.id}/conversations/csv?token=share-coding`)).text();
  expect(conversationsCsv.split('\n')[0]).toBe('Session ID,User,Started At,Finished At,Message,Is LEIA,Timestamp,Score,Evaluation');
  expect(conversationsCsv).not.toContain('twoSum');

  const live = await (await request(`/spectator/replications/${replication.id}/sessions?token=share-coding`)).json();
  const liveSession = live.sessions.find((entry) => entry.id === sessionId);
  expect(liveSession.testRunCount).toBe(2);
  expect(liveSession.testRuns.every((run) => !('code' in run))).toBe(true);

  const studentView = JSON.stringify(await (await request(`/interactions/${sessionId}`)).json());
  expect(studentView).not.toContain('testRuns');
  expect(studentView).not.toContain('reportedToLeiaAt');
});
