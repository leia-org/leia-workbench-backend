import { beforeEach, expect, test, vi } from 'vitest';
vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({ default: { findById: vi.fn(), update: vi.fn() } }));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({ default: {} }));
vi.mock('../src/services/v1/ManagerService.js', () => ({ default: {} }));
import ReplicationRepository from '../src/repositories/v1/ReplicationRepository.js';
import ReplicationService from '../src/services/v1/ReplicationService.js';

let replication;
beforeEach(() => {
  vi.resetAllMocks();
  replication = { isActive: true, reflectiveEnabled: false, experiment: { leias: [
    { id: 'normal', configuration: { askSolution: true } },
    { id: 'reflective', leia: { spec: { behaviour: { spec: { reflective: true, evaluationPrompt: 'Explain', stoppingPrompt: 'Conclude' } } } } },
  ] } };
  ReplicationRepository.findById.mockResolvedValue(replication);
  ReplicationRepository.update.mockImplementation(async (_id, update) => ({ ...replication, ...update }));
});

test('enables and disables reflection, including while a replication is active', async () => {
  expect((await ReplicationService.toggleReflective('rep')).reflectiveEnabled).toBe(true);
  replication.reflectiveEnabled = true;
  expect((await ReplicationService.toggleReflective('rep')).reflectiveEnabled).toBe(false);
});

test('requires a configured reflective successor and a normal solution collection step', async () => {
  replication.experiment.leias[0].configuration.askSolution = false;
  await expect(ReplicationService.toggleReflective('rep')).rejects.toThrow(/student solution/);
  replication.experiment.leias.pop();
  await expect(ReplicationService.toggleReflective('rep')).rejects.toThrow(/Add a Reflective/);
  expect(ReplicationRepository.update).not.toHaveBeenCalled();
});

test('does not require a provider for disabled reflective entries when activating normal LEIAs', () => {
  replication.experiment.leias[0].runnerConfiguration = { modelName: 'model', apiKeyId: 'key', apiKeyRequesterId: 'owner' };
  expect(ReplicationService._getLeiasWithInvalidRunnerConfiguration(replication)).toEqual([]);
  replication.reflectiveEnabled = true;
  expect(ReplicationService._getLeiasWithInvalidRunnerConfiguration(replication)).toEqual([
    { leiaId: 'reflective', missingFields: ['modelName', 'apiKeyId', 'apiKeyRequesterId'] },
  ]);
});
