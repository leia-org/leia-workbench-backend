import { beforeEach, expect, test, vi } from 'vitest';
vi.mock('../src/repositories/v1/ReplicationRepository.js', () => ({ default: { findById: vi.fn(), update: vi.fn() } }));
vi.mock('../src/repositories/v1/SessionRepository.js', () => ({ default: {} }));
vi.mock('../src/services/v1/ManagerService.js', () => ({ default: {} }));
import ReplicationService from '../src/services/v1/ReplicationService.js';

let replication;
beforeEach(() => {
  vi.resetAllMocks();
  replication = { experiment: { leias: [
    { id: 'first', runnerConfiguration: { modelName: 'model', apiKeyId: 'key', apiKeyRequesterId: 'owner' } },
    { id: 'second', leia: { spec: { behaviour: { spec: { description: '{{reflectiveContext.previousConversation}}' } } } } },
  ] } };
});

test('every LEIA requires a runner configuration regardless of context use', () => {
  expect(ReplicationService._getLeiasWithInvalidRunnerConfiguration(replication)).toEqual([
    { leiaId: 'second', missingFields: ['modelName', 'apiKeyId', 'apiKeyRequesterId'] },
  ]);
});
