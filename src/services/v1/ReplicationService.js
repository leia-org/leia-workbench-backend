import ReplicationRepository from '../../repositories/v1/ReplicationRepository.js';
import SessionRepository from '../../repositories/v1/SessionRepository.js';
import ManagerService from './ManagerService.js';
import { initializeExperiment } from '../../utils/entity.js';
import axios from 'axios';
import { stringify } from 'csv-stringify/sync';

const REPLICATION_CONFIG_CSV_EXCLUDED_COLUMNS = new Set([
  'replicationConfig_capturedAt',
  'replicationConfig_replication_id',
  'replicationConfig_leia_id',
  'replicationConfig_leia_activity_widgets'
]);

function normalizeCSVValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || (value && typeof value === 'object')) return JSON.stringify(value);
  return value;
}

function flattenObject(value, prefix = '') {
  if (!value || typeof value !== 'object') return {};

  const source = typeof value.toObject === 'function' ? value.toObject({ virtuals: false }) : value;
  const flattened = {};

  for (const [key, childValue] of Object.entries(source)) {
    if (childValue === undefined) continue;

    const path = prefix ? `${prefix}_${key}` : key;
    const isPlainObject =
      childValue &&
      typeof childValue === 'object' &&
      !Array.isArray(childValue) &&
      !(childValue instanceof Date);

    if (isPlainObject) {
      Object.assign(flattened, flattenObject(childValue, path));
    } else {
      flattened[path] = normalizeCSVValue(childValue);
    }
  }

  return flattened;
}

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
      const invalidLeias = this._getLeiasWithInvalidRunnerConfiguration(replication);
      if (invalidLeias.length > 0) {
        const error = new Error('Some Leias have invalid runner configurations');
        error.statusCode = 400;
        error.invalidLeias = invalidLeias;
        throw error;
      }
    }
    return await ReplicationRepository.toggleIsActive(id);
  }
  _getLeiasWithInvalidRunnerConfiguration(replication) {
    const invalidLeias = [];
    for (const leia of replication.experiment.leias) {
      const config = leia.runnerConfiguration || {};
      const missingFields = [];
      if (!config.modelName) missingFields.push('modelName');
      if (!config.apiKeyId) missingFields.push('apiKeyId');
      if (!config.apiKeyRequesterId) missingFields.push('apiKeyRequesterId');
      if (missingFields.length > 0) {
        invalidLeias.push({ leiaId: leia.id, missingFields });
      }
    }
    return invalidLeias;
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

  async updateDataUsage(id, dataUsageConfig) {
    return await ReplicationRepository.update(id, {
      dataUsageConfig: {
        ...dataUsageConfig,
        conversationAutomatedRemoval: dataUsageConfig.dataUsageConsentRequired
          ? dataUsageConfig.conversationAutomatedRemoval
          : false,
      },
    });
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
    const exportableSessions = sessions.filter((session) => session.dataUsage?.consentStatus !== 'declined');
    const replicationConfigRows = exportableSessions.map((session) =>
      flattenObject(session.replicationConfig, 'replicationConfig')
    );
    const replicationConfigColumns = [...new Set(replicationConfigRows.flatMap((row) => Object.keys(row)))]
      .filter((column) => !REPLICATION_CONFIG_CSV_EXCLUDED_COLUMNS.has(column))
      .sort();
    const dataUsageRows = exportableSessions.map((session) => flattenObject(session.dataUsage, 'dataUsage'));
    const dataUsageColumns = [...new Set(dataUsageRows.flatMap((row) => Object.keys(row)))].sort();
    const columns = [
      'Session ID',
      'User',
      'Started At',
      'Finished At',
      'Message',
      'Is LEIA',
      'Timestamp',
      'Score',
      'Evaluation',
      ...replicationConfigColumns,
      ...dataUsageColumns,
    ];

    const records = exportableSessions.flatMap((session, index) => {
      const baseRecord = {
        'Session ID': session.id || '',
        User: session.user?.email || session.user?.id || 'Anonymous',
        'Started At': session.startedAt ? new Date(session.startedAt).toISOString() : '',
        'Finished At': session.finishedAt ? new Date(session.finishedAt).toISOString() : '',
        Score: session.score ?? '',
        Evaluation: session.evaluation || '',
        ...replicationConfigRows[index],
        ...dataUsageRows[index],
      };
      const messages = session.messages?.length ? session.messages : [{ text: 'No messages' }];

      return messages.map((message) => ({
        ...baseRecord,
        Message: message.text || '',
        'Is LEIA': message.isLeia === undefined ? '' : message.isLeia ? 'TRUE' : 'FALSE',
        Timestamp: message.timestamp ? new Date(message.timestamp).toISOString() : '',
      }));
    });

    return stringify(records, { header: true, columns, record_delimiter: '\n' });
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
