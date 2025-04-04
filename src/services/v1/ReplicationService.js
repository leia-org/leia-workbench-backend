import ReplicationRepository from '../../repositories/v1/ReplicationRepository.js';
import SessionRepository from '../../repositories/v1/SessionRepository.js';
import ManagerService from './ManagerService.js';
import { initializeExperiment } from '../../utils/entity.js';

class ReplicationService {
  // READ METHODS

  async findAll() {
    return await ReplicationRepository.findAll();
  }

  async findById(id) {
    return await ReplicationRepository.findById(id);
  }

  async findByCode(code) {
    return await ReplicationRepository.findByCode(code);
  }

  async findLeia(id, leiaId) {
    return await ReplicationRepository.findLeia(id, leiaId);
  }

  async hasReplicationStarted(replicationId) {
    return await SessionRepository.hasReplicationStarted(replicationId);
  }

  // WRITE METHODS

  async create(replicationData) {
    const experiment = await ManagerService.findExperimentById(replicationData.experiment);
    const initializedExperiment = initializeExperiment(experiment);
    replicationData.experiment = initializedExperiment;
    return await ReplicationRepository.create(replicationData);
  }

  async updateName(id, name) {
    return await ReplicationRepository.update(id, { name });
  }

  async regenerateCode(id) {
    return await ReplicationRepository.regenerateCode(id);
  }

  async toggleIsActive(id) {
    return await ReplicationRepository.toggleIsActive(id);
  }

  async toggleIsRepeatable(id) {
    return await ReplicationRepository.toggleIsRepeatable(id);
  }

  async updateDuration(id, duration) {
    return await ReplicationRepository.update(id, { duration });
  }

  async updateExperiment(id, experimentId) {
    if (SessionRepository.hasReplicationStarted(id)) {
      const error = new Error('Replication has already started, cannot update experiment');
      error.status = 400;
      throw error;
    }
    const experiment = await ManagerService.findExperimentById(experimentId);
    const initializedExperiment = initializeExperiment(experiment);
    return await ReplicationRepository.update(id, { initializedExperiment });
  }

  async updateLeiaRunnerConfiguration(id, leiaId, runnerConfiguration) {
    return await ReplicationRepository.updateLeiaRunnerConfiguration(id, leiaId, runnerConfiguration);
  }

  async getAndIncrementNextLeia(id) {
    return await ReplicationRepository.getAndIncrementNextLeia(id);
  }

  async updateForm(id, form) {
    return await ReplicationRepository.update(id, { form });
  }

  async deleteForm(id) {
    return await ReplicationRepository.update(id, { form: null });
  }
}

export default new ReplicationService();
