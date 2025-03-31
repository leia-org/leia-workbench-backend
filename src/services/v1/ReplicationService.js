import ReplicationRepository from '../../repositories/v1/ReplicationRepository.js';
import ManagerService from './ManagerService.js';

class ReplicationService {
  // READ METHODS

  async findAll() {
    return await ReplicationRepository.findAll();
  }

  async findById(id) {
    return await ReplicationRepository.findById(id);
  }

  // WRITE METHODS

  async create(replicationData) {
    replicationData.experiment = await ManagerService.findExperimentById(replicationData.experiment);
    for (const leia of replicationData.experiment.leias) {
      leia.runnerConfig = {
        provider: 'openai',
      };
    }
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

  async updateDuration(id, duration) {
    return await ReplicationRepository.update(id, { duration });
  }

  async updateExperiment(id, experimentId) {
    const experiment = await ManagerService.findExperimentById(experimentId);
    for (const leia of experiment.leias) {
      leia.runnerConfig = {
        provider: 'openai',
      };
    }
    return await ReplicationRepository.update(id, { experiment });
  }

  async updateLeiaRunnerConfig(id, leiaId, runnerConfig) {
    return await ReplicationRepository.updateLeiaRunnerConfig(id, leiaId, runnerConfig);
  }
}

export default new ReplicationService();
