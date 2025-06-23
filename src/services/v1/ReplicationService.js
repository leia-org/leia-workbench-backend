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

  async toggleAskSolution(id, leiaId) {
    const leia = await ReplicationRepository.findLeia(id, leiaId);
    if (!leia) {
      const error = new Error('Leia not found');
      error.status = 404;
      throw error;
    }

    const askSolutionStatus = !leia.configuration.askSolution;
    const evaluatedSolutionStatus = leia.configuration.evaluateSolution;

    let updatedReplication;

    if (!askSolutionStatus && evaluatedSolutionStatus) {
      updatedReplication = await ReplicationRepository.updateAskSolutionAndEvaluateSolution(
        id,
        leiaId,
        askSolutionStatus,
        false
      );
    } else {
      updatedReplication = await ReplicationRepository.updateAskSolution(id, leiaId, askSolutionStatus);
    }
    return updatedReplication;
  }

  async toggleEvaluateSolution(id, leiaId) {
    const leia = await ReplicationRepository.findLeia(id, leiaId);
    if (!leia) {
      const error = new Error('Leia not found');
      error.status = 404;
      throw error;
    }

    const askSolutionStatus = leia.configuration.askSolution;
    const evaluateSolutionStatus = !leia.configuration.evaluateSolution;

    let updatedReplication;

    if (!askSolutionStatus && evaluateSolutionStatus) {
      updatedReplication = await ReplicationRepository.updateAskSolutionAndEvaluateSolution(
        id,
        leiaId,
        true,
        evaluateSolutionStatus
      );
    } else {
      updatedReplication = await ReplicationRepository.updateEvaluateSolution(id, leiaId, evaluateSolutionStatus);
    }
    return updatedReplication;
  }
}

export default new ReplicationService();
