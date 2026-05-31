import ReplicationRepository from '../../repositories/v1/ReplicationRepository.js';
import SessionRepository from '../../repositories/v1/SessionRepository.js';
import ManagerService from './ManagerService.js';
import { initializeExperiment } from '../../utils/entity.js';
import axios from 'axios';

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

  async checkAccess(id, isAdmin, token) {
    if (!isAdmin) {
      const hasAccess = await ReplicationRepository.checkSharedAccess(id, token);
      if (!hasAccess) {
        const error = new Error('Access denied');
        error.status = 403;
        throw error;
      }
    }
  }

  async checkNameExists(name) {
    return await ReplicationRepository.existsByName(name);
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

  async regenerateShareToken(id) {
    return await ReplicationRepository.regenerateShareToken(id);
  }

  async toggleIsActive(id) {
    const replication = await ReplicationRepository.findById(id);
    if (!replication) {
      const error = new Error('Replication not found');
      error.statusCode = 404;
      throw error;
    }
    if (!replication.isActive) {
      const hasValidRunnerConfig = this._checkAllLeiasHaveValidRunnerConfiguration(replication);
      if (!hasValidRunnerConfig) {
        const error = new Error('Some Leias have invalid runner configurations');
        error.statusCode = 400;
        throw error;
      }
    }
    return await ReplicationRepository.toggleIsActive(id);
  }
  _checkAllLeiasHaveValidRunnerConfiguration(replication) {
    for (const leia of replication.experiment.leias) {
      if (!leia.runnerConfiguration?.modelName || !leia.runnerConfiguration?.apiKeyId || !leia.runnerConfiguration?.apiKeyRequesterId) {
        return false;
      }
    }
    return true;
  }
  async toggleIsShared(id) {
    return await ReplicationRepository.toggleIsShared(id);
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

  async deleteDuration(id) {
    return await ReplicationRepository.update(id, { duration: null });
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

  async getConversations(id) {
    const sessions = await SessionRepository.findByReplicationAndPopulateMessages(id);
    return sessions;
  }

  async getConversationsCSV(id) {
    const sessions = await SessionRepository.findByReplicationAndPopulateMessages(id);

    let csv = 'Session ID,User,Started At,Finished At,Message,Is LEIA,Timestamp,Score,Evaluation\n';

    for (const session of sessions) {
      const sessionId = session.id || '';
      const userId = session.user?.email || session.user?.id || 'Anonymous';
      const startedAt = session.startedAt ? new Date(session.startedAt).toISOString() : '';
      const finishedAt = session.finishedAt ? new Date(session.finishedAt).toISOString() : '';
      const score = session.score || '';
      const evaluation = session.evaluation ? `"${session.evaluation.replace(/"/g, '""')}"` : '';

      if (session.messages && session.messages.length > 0) {
        for (const message of session.messages) {
          const messageText = message.text ? `"${message.text.replace(/"/g, '""')}"` : '';
          const isLeia = message.isLeia ? 'TRUE' : 'FALSE';
          const timestamp = message.timestamp ? new Date(message.timestamp).toISOString() : '';

          csv += `${sessionId},${userId},${startedAt},${finishedAt},${messageText},${isLeia},${timestamp},${score},${evaluation}\n`;
        }
      } else {
        csv += `${sessionId},${userId},${startedAt},${finishedAt},"No messages",,,${score},${evaluation}\n`;
      }
    }

    return csv;
  }

  async getProviderAndProviderModuleForReplication(modelName) {
    const {data} = await axios.get(`${process.env.RUNNER_URL}/api/v1/models`, {
      headers: {
        Authorization: 'Bearer ' + process.env.RUNNER_KEY,
      },
    });
    const provider = Object.entries(data.apiKeyProviders || {})
      .find(([, models]) => models.includes(modelName))?.[0];

    if (!provider) throw new Error(`Model '${modelName}' not mapped to provider`);
    const providerDriver = data.providerProviderModuleMap?.[provider];
    if (!providerDriver) throw new Error(`No provider module for provider '${provider}'`);

    return { provider, providerDriver };
  }

  async validateApiKeyProviderForReplication(provider, apiKeyId, apiKeyRequesterId) {
    try {
      const config = {
        headers: {
          "x-intern-token": process.env.INTERN_TOKEN,
        }
      };
      const resp = await axios.post(`${process.env.AUTH_URL}/api/v1/apikeys/validate-provider`, { provider, apiKeyId, apiKeyRequesterId }, config);
      return resp.data.isCompatible;
    } catch (error) {
      console.error('Error validating API key provider:', error.response?.data || error.message);
      throw new Error('Invalid API Key provider');
    }
  }
}

export default new ReplicationService();
