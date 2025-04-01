import ReplicationRepository from '../../repositories/v1/ReplicationRepository.js';
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
    const experiment = await ManagerService.findExperimentById(experimentId);
    const initializedExperiment = initializeExperiment(experiment);
    return await ReplicationRepository.update(id, { initializedExperiment });
  }

  async updateLeiaRunnerConfig(id, leiaId, runnerConfig) {
    return await ReplicationRepository.updateLeiaRunnerConfig(id, leiaId, runnerConfig);
  }

  async getAndIncrementNextLeia(id) {
    return await ReplicationRepository.getAndIncrementNextLeia(id);
  }
}

export default new ReplicationService();
