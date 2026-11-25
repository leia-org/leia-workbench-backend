import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import Replication from '../../src/models/Replication.js';
import ActivityRun from '../../src/models/ActivityRun.js';
import Session from '../../src/models/Session.js';
import Message from '../../src/models/Message.js';
import User from '../../src/models/User.js';
import replicationRoutes from '../../src/routes/v1/replicationRoutes.js';
import interactionRoutes from '../../src/routes/v1/interactionRoutes.js';
import { auth } from '../../src/middlewares/auth.js';
import errorHandler from '../../src/middlewares/errorHandler.js';
import { processConversationRemoval } from '../../src/services/v1/ConversationRemovalService.js';
import { connectMongo, closeMongo, listen } from './support.js';

let http, peers;
const owner = new mongoose.Types.ObjectId().toString();
const experimentId = new mongoose.Types.ObjectId().toString();
const leiaConfigId = new mongoose.Types.ObjectId().toString();
const forwarded = [];
const traceRemovalRequests = [];
const stagedExperimentId = new mongoose.Types.ObjectId().toString();
let stagedExperiment;
const bearer = jwt.sign({ id: owner, role: 'advanced' }, 'integration-signing-secret');
const experiment = { id: experimentId, user: { id: owner }, leias: [{
  id: leiaConfigId, configuration: { mode: 'standard' },
  leia: { id: new mongoose.Types.ObjectId().toString(), metadata: { name: 'Interview LEIA' }, spec: {
    problem: { spec: { solution: 'Private solution', evaluationPrompt: 'Private evaluation' } },
    behaviour: { spec: { description: 'Private instructions' } },
  } },
}] };
const request = (path, method = 'GET', body, authorization = bearer) => fetch(`${http.url}/api/v1${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', 'integration-signing-secret'); vi.stubEnv('JWT_ISSUER', ''); vi.stubEnv('JWT_AUDIENCE', '');
  vi.stubEnv('RUNNER_KEY', 'integration-runner');
  await connectMongo(); await Replication.init(); await ActivityRun.init(); await Session.init(); await User.init();
  const peer = express(); peer.use(express.json());
  peer.use((req, _res, next) => { forwarded.push({ path: req.path, body: req.body, authorization: req.headers.authorization }); next(); });
  peer.get('/api/v1/experiments/:id', (req, res) => res.json(
    req.params.id === stagedExperimentId ? stagedExperiment : experiment,
  ));
  peer.get('/api/v1/apikeys', (_req, res) => res.json([{ id: 'local-key', provider: 'ollama', model: 'fixture-model', isDefault: true }]));
  peer.get('/api/v1/models', (_req, res) => res.json({ apiKeyProviders: { ollama: ['fixture-model'] }, providerProviderModuleMap: { ollama: 'ollama' } }));
  peer.post('/api/v1/leias', (req, res) => res.status(201).json({ sessionId: req.body.sessionId }));
  peer.post('/api/v1/multi-leias', (req, res) => res.status(201).json({ sessionId: req.body.sessionId, state: {} }));
  peer.post('/api/v1/leias/:id/messages', (req, res) => res.json({ message: `Answer: ${req.body.message}` }));
  peer.delete('/api/v1/cache/purge', (_req, res) => res.json({ success: true }));
  peer.delete('/api/v1/leias/:id/traces', (req, res) => {
    const previous = traceRemovalRequests.filter(({ sessionId }) => sessionId === req.params.id);
    traceRemovalRequests.push({ sessionId: req.params.id, from: req.query.from, authorization: req.headers.authorization });
    if (previous.length === 0) return res.status(502).json({ error: 'Test outage' });
    return res.json({ complete: previous.length > 1 });
  });
  peers = await listen(peer);
  for (const key of ['AUTH_URL', 'MANAGER_URL', 'RUNNER_URL']) vi.stubEnv(key, peers.url);
  const app = express(); app.use(express.json(), auth);
  app.use('/api/v1/replications', replicationRoutes); app.use('/api/v1/interactions', interactionRoutes); app.use(errorHandler);
  http = await listen(app);
});

test('stage transitions are sequential and retryable and only the selected stage supplies outputs', async () => {
  const [first, second, last] = Array.from({ length: 3 }, () => ({
    id: randomUUID(), orchestration: { mode: 'single' },
  }));
  last.outputSources = { conversation: second.id, submitedSolution: first.id };
  last.orchestration = { mode: 'multi', maxInternalTurns: 2 };
  const leias = [first, second, last, last].map(({ id: stageId }, index) => {
    const entry = structuredClone(experiment.leias[0]);
    entry.id = new mongoose.Types.ObjectId().toString();
    entry.stageId = stageId;
    if (index >= 2) {
      entry.leia.spec.behaviour.spec.description =
        'Review: {{previousStage.outputs.conversation}}\nAnswer: {{previousStage.outputs.submitedSolution}}';
    }
    return entry;
  });
  stagedExperiment = { id: stagedExperimentId, stages: [first, second, last], leias };
  const created = await request('/replications', 'POST', {
    name: 'Staged integration replication', experiment: stagedExperimentId,
  });
  expect(created.status).toBe(201);
  const replication = await created.json();
  expect(replication.experiment.stages.map(({ id }) => id)).toEqual([first.id, second.id, last.id]);
  // Stage 1 supplies submitedSolution so Ask for student solution cannot be disabled; Stage 2 only supplies conversation.
  expect((await request(`/replications/${replication.id}/leia/${leias[0].id}/toggle-ask-solution`, 'PATCH')).status).toBe(400);
  expect((await request(`/replications/${replication.id}/leia/${leias[1].id}/toggle-ask-solution`, 'PATCH')).status).toBe(200);
  const body = { replicationId: replication.id, staged: true };
  const unauthorized = jwt.sign({ id: new mongoose.Types.ObjectId().toString(), role: 'advanced' }, 'integration-signing-secret');
  expect((await request('/interactions/test', 'POST', body, unauthorized)).status).toBe(403);
  const tested = await request('/interactions/test', 'POST', body);
  expect(tested.status).toBe(201);
  expect(await Session.findById((await tested.json()).sessionId)).toMatchObject({ isTest: true, stageId: first.id });
  expect((await request(`/replications/${replication.id}/toggle-active`, 'PATCH')).status).toBe(200);
  const student = { email: 'stage-student@example.com', code: replication.code };
  const start = () => request('/interactions', 'POST', student, null);
  const post = (id, action, body) => request(`/interactions/${id}/${action}`, 'POST', body, null);

  const [firstStart, retriedStart] = await Promise.all([start(), start()]);
  expect(firstStart.status).toBe(201);
  expect(retriedStart.status).toBe(201);
  const { sessionId: interview } = await firstStart.json();
  expect((await retriedStart.json()).sessionId).toBe(interview);
  expect((await post(interview, 'next-stage')).status).toBe(409);
  expect((await post(interview, 'messages', { message: 'Interview facts' })).status).toBe(200);
  const submitted = await post(interview, 'result', { result: 'Interview answer' });
  const submittedData = await submitted.json();
  expect(submittedData.stage).toMatchObject({ number: 1, total: 3, hasNext: true });
  expect(submittedData.runId).toBeTruthy();
  // Reference solution and evaluation visibility is instructor-controlled via showSolution.
  expect((await request(`/interactions/${interview}/solution`, 'GET', undefined, null)).status).toBe(200);
  expect((await request(`/replications/${replication.id}/leia/${leias[0].id}/toggle-show-solution`, 'PATCH')).status).toBe(200);
  expect((await request(`/interactions/${interview}/solution`, 'GET', undefined, null)).status).toBe(403);
  expect((await request(`/interactions/${interview}/evaluation`, 'GET', undefined, null)).status).toBe(403);

  const reviews = await Promise.all([start(), post(interview, 'next-stage')]);
  const reviewIds = await Promise.all(reviews.map(async (response) => (await response.json()).sessionId));
  expect(reviewIds[0]).toBeTruthy();
  expect(reviewIds[0]).toBe(reviewIds[1]);
  expect(await Session.countDocuments({ replication: replication.id, stageId: second.id })).toBe(1);
  const review = reviewIds[0];
  expect((await post(review, 'messages', { message: 'Review facts' })).status).toBe(200);
  expect((await post(review, 'finish')).status).toBe(200);

  // Deactivating the replication mid-run still allows the in-progress participant to finish remaining stages.
  expect((await request(`/replications/${replication.id}/toggle-active`, 'PATCH')).status).toBe(200);
  const { sessionId: debrief } = await (await post(review, 'next-stage')).json();
  const initialization = forwarded.find(({ path, body }) => path === '/api/v1/multi-leias' && body.sessionId === debrief);
  expect(initialization.body.actors).toHaveLength(2);
  for (const actor of initialization.body.actors) {
    const description = actor.leia.spec.behaviour.spec.description;
    expect(description).toContain('Review facts');
    expect(description).toContain('Interview answer');
    expect(description).not.toContain('Interview facts');
  }
  const session = await (await request(`/interactions/${debrief}`, 'GET', undefined, null)).json();
  expect(session.session.stage).toEqual({ number: 3, total: 3, hasNext: false });
  expect(session.session.runId).toBe(submittedData.runId);
  expect(session.session.previousStageSession).toBeUndefined();
  expect(session.leia.leia.spec.behaviour.spec.description).toBeUndefined();
  expect(session.replication.experiment).toBeUndefined();
  expect((await ActivityRun.findById(submittedData.runId)).finishedAt).toBeNull();
  expect((await post(debrief, 'finish')).status).toBe(200);
  expect((await ActivityRun.findById(submittedData.runId)).finishedAt).toBeInstanceOf(Date);
  // Re-activate to verify non-repeatable run is rejected with 403.
  expect((await request(`/replications/${replication.id}/toggle-active`, 'PATCH')).status).toBe(200);
  expect((await start()).status).toBe(403);
});
afterAll(async () => { await http?.close(); await peers?.close(); await closeMongo(); vi.unstubAllEnvs(); });

test('data usage settings remove a declined conversation and its traces at completion, with durable retries', async () => {
  const created = await request('/replications', 'POST', { name: 'Retention integration replication', experiment: experimentId });
  expect(created.status).toBe(201);
  const { id, code } = await created.json();
  const config = {
    dataUsageConsentRequired: true,
    dataUsageConsentMessage: 'Choose whether to retain the test conversation.',
    conversationAutomatedRemoval: true,
  };
  const patch = '/replications/' + id + '/data-usage';
  const outsider = jwt.sign({ id: new mongoose.Types.ObjectId().toString(), role: 'advanced' }, 'integration-signing-secret');
  expect((await request(patch, 'PATCH', { dataUsageConfig: config }, outsider)).status).toBe(403);
  expect((await request(patch, 'PATCH', { dataUsageConfig: config })).status).toBe(200);
  expect((await request(`/replications/${id}/toggle-active`, 'PATCH')).status).toBe(200);

  const join = async (email) => {
    const response = await request('/interactions', 'POST', { email, code }, null);
    expect(response.status).toBe(201);
    return (await response.json()).sessionId;
  };
  const declined = await join('declined-fixture@example.com');
  const accepted = await join('accepted-fixture@example.com');
  const post = (sessionId, endpoint, body) => request(`/interactions/${sessionId}/${endpoint}`, 'POST', body, null);
  expect((await post(declined, 'messages', { message: 'Too early' })).status).toBe(403);
  expect((await (await post(declined, 'data-usage-consent', { accepted: false })).json())
    .session.dataUsage.consentStatus).toBe('declined');
  expect((await post(declined, 'data-usage-consent', { accepted: true })).status).toBe(409);
  expect((await post(accepted, 'data-usage-consent', { accepted: true })).status).toBe(200);
  for (const sessionId of [declined, accepted]) {
    expect((await post(sessionId, 'messages', { message: 'Synthetic test message' })).status).toBe(200);
    expect(await Message.countDocuments({ session: sessionId })).toBe(2);
  }
  const csv = await (await request(`/replications/${id}/conversations/csv`)).text();
  expect(csv).toContain(accepted);
  expect(csv).not.toContain(declined);
  expect(await processConversationRemoval(new Date(Date.now() + 3600000))).toBe(false);
  expect((await post(declined, 'finish')).status).toBe(200);
  expect((await post(accepted, 'result', { result: 'Synthetic answer' })).status).toBe(200);
  const marked = await Session.findById(declined).select('+conversationRemovalDueAt');
  const untouched = await Session.findById(accepted).select('+conversationRemovalDueAt');
  expect(marked.conversationRemovalDueAt).toBeInstanceOf(Date);
  expect(untouched.conversationRemovalDueAt).toBeUndefined();
  expect(await processConversationRemoval()).toBe(false);
  const firstAttempt = marked.conversationRemovalDueAt.getTime();
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(await processConversationRemoval(new Date(firstAttempt + attempt * 120000))).toBe(true);
  }
  expect(await processConversationRemoval(new Date(firstAttempt + 600000))).toBe(false);
  expect(traceRemovalRequests.map(({ sessionId }) => sessionId)).toEqual(Array(4).fill(declined));
  expect(traceRemovalRequests.every(({ authorization }) => authorization === 'Bearer integration-runner')).toBe(true);
  expect(await Message.countDocuments({ session: declined })).toBe(0);
  expect(await Message.countDocuments({ session: accepted })).toBe(2);
  expect(await Session.findById(declined)).toMatchObject({ dataUsage: { automatedRemovalApplied: true } });
});

test('keeps a finished stage conversation until the activity run is finished', async () => {
  const replication = new mongoose.Types.ObjectId();
  const run = await ActivityRun.create({ replication, isTest: true });
  const due = new Date();
  const session = await Session.create({
    replication,
    leia: leiaConfigId,
    stageId: 'first-stage',
    run: run.id,
    finishedAt: due,
    conversationRemovalDueAt: due,
    dataUsage: {
      config: { dataUsageConsentRequired: true, conversationAutomatedRemoval: true },
      consentStatus: 'declined',
    },
  });
  await Message.create({ session: session.id, text: 'Required by the next stage', isLeia: false });
  expect(await processConversationRemoval(due)).toBe(true);
  expect(await Message.countDocuments({ session: session.id })).toBe(1);
  expect(traceRemovalRequests.some(({ sessionId }) => sessionId === session.id)).toBe(false);
  await ActivityRun.updateOne({ _id: run.id }, { $set: { finishedAt: new Date() } });
  expect(await processConversationRemoval(new Date(due.getTime() + 120000))).toBe(true);
  expect(await Message.countDocuments({ session: session.id })).toBe(0);
  expect(traceRemovalRequests.some(({ sessionId }) => sessionId === session.id)).toBe(true);
});

test('replication → activation → student chat → finish persists the conversation and prevents repeating a completed experiment', async () => {
  const created = await request('/replications', 'POST', { name: 'Integration replication', experiment: experimentId });
  expect(created.status).toBe(201);
  const replication = await created.json();
  expect(replication.code).toBeTruthy();
  expect(replication.experiment.leias[0].runnerConfiguration).toMatchObject({ apiKeyId: 'local-key', apiKeyRequesterId: owner, provider: 'ollama', modelName: 'fixture-model' });
  expect((await request(`/replications/${replication.id}/toggle-active`, 'PATCH')).status).toBe(200);
  expect((await Replication.findById(replication.id)).isActive).toBe(true);
  const student = { email: 'student@example.com', code: replication.code };
  const started = await request('/interactions', 'POST', student, null);
  expect(started.status).toBe(201);
  const { sessionId } = await started.json();
  // Rejoining an unfinished activity reuses its session and initializes Runner only once.
  expect((await (await request('/interactions', 'POST', student, null)).json()).sessionId).toBe(sessionId);
  expect(forwarded.filter((req) => req.path === '/api/v1/leias' && req.body.sessionId === sessionId)).toHaveLength(1);
  const sent = await request(`/interactions/${sessionId}/messages`, 'POST', { message: 'What is the problem?' }, null);
  expect(sent.status).toBe(200);
  expect((await sent.json()).message).toBe('Answer: What is the problem?');
  const messages = await Message.find({ session: sessionId });
  expect(messages.map((message) => [message.text, message.isLeia])).toEqual([
    ['What is the problem?', false], ['Answer: What is the problem?', true],
  ]);
  expect((await Session.findById(sessionId)).messages).toHaveLength(2);
  const studentView = await (await request(`/interactions/${sessionId}`, 'GET', undefined, null)).json();
  expect(JSON.stringify(studentView)).not.toContain('Private solution');
  expect(JSON.stringify(studentView)).not.toContain('Private instructions');
  const finished = await request(`/interactions/${sessionId}/finish`, 'POST', {}, null);
  expect(finished.status).toBe(200);
  expect((await Session.findById(sessionId)).finishedAt).toBeInstanceOf(Date);
  expect((await request('/interactions', 'POST', student, null)).status).toBe(403);
  expect(forwarded.find((req) => req.path === '/api/v1/leias').authorization).toBe('Bearer integration-runner');
});

test('sharing is persisted, scopes access to one replication and can be revoked', async () => {
  const replication = await Replication.create({ name: 'Shared integration', experiment });
  const unrelated = await Replication.create({ name: 'Other integration', experiment });
  const share = await request(`/replications/${replication.id}/toggle-shared`, 'PATCH');
  expect(share.status).toBe(200);
  const { shareToken } = await share.json();
  expect(shareToken).toBeTruthy();
  expect((await request(`/replications/${replication.id}?token=${shareToken}`, 'GET', undefined, null)).status).toBe(200);
  expect((await request(`/replications/${unrelated.id}?token=${shareToken}`, 'GET', undefined, null)).status).toBe(403);
  expect((await request(`/replications/${replication.id}/toggle-shared`, 'PATCH')).status).toBe(200);
  expect((await request(`/replications/${replication.id}?token=${shareToken}`, 'GET', undefined, null)).status).toBe(403);
});
