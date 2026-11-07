import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import Replication from '../../src/models/Replication.js';
import Session from '../../src/models/Session.js';
import Message from '../../src/models/Message.js';
import replicationRoutes from '../../src/routes/v1/replicationRoutes.js';
import interactionRoutes from '../../src/routes/v1/interactionRoutes.js';
import { auth } from '../../src/middlewares/auth.js';
import errorHandler from '../../src/middlewares/errorHandler.js';
import { connectMongo, closeMongo, listen } from './support.js';

let http, peers;
const owner = new mongoose.Types.ObjectId().toString();
const experimentId = new mongoose.Types.ObjectId().toString();
const leiaConfigId = new mongoose.Types.ObjectId().toString();
const forwarded = [];
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
  await connectMongo(); await Replication.init();
  const peer = express(); peer.use(express.json());
  peer.use((req, _res, next) => { forwarded.push({ path: req.path, body: req.body, authorization: req.headers.authorization }); next(); });
  peer.get('/api/v1/experiments/:id', (_req, res) => res.json(experiment));
  peer.get('/api/v1/apikeys', (_req, res) => res.json([{ id: 'local-key', provider: 'ollama', model: 'fixture-model', isDefault: true }]));
  peer.get('/api/v1/models', (_req, res) => res.json({ apiKeyProviders: { ollama: ['fixture-model'] }, providerProviderModuleMap: { ollama: 'ollama' } }));
  peer.post('/api/v1/leias', (req, res) => res.status(201).json({ sessionId: req.body.sessionId }));
  peer.post('/api/v1/leias/:id/messages', (req, res) => res.json({ message: `Answer: ${req.body.message}` }));
  peer.delete('/api/v1/cache/purge', (_req, res) => res.json({ success: true }));
  peers = await listen(peer);
  for (const key of ['AUTH_URL', 'MANAGER_URL', 'RUNNER_URL']) vi.stubEnv(key, peers.url);
  const app = express(); app.use(express.json(), auth);
  app.use('/api/v1/replications', replicationRoutes); app.use('/api/v1/interactions', interactionRoutes); app.use(errorHandler);
  http = await listen(app);
});
afterAll(async () => { await http?.close(); await peers?.close(); await closeMongo(); vi.unstubAllEnvs(); });

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
  expect(forwarded.filter((req) => req.path === '/api/v1/leias')).toHaveLength(1);
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
