import ReplicationRepository from '../../repositories/v1/ReplicationRepository.js';
import SessionRepository from '../../repositories/v1/SessionRepository.js';
import ManagerService from './ManagerService.js';
import { initializeExperiment } from '../../utils/entity.js';
import {
  PREVIOUS_STAGE_VIEW_AVAILABILITIES,
  activityError,
  activityFlows,
  getSolutionRequirementForLeia,
  getStageProblemLeia,
  getStagesRequiringSolution,
  stageHasAskSolutionEnabled,
} from '../../utils/activityStages.js';
import {
  collectRubricCsvColumns,
  extractRubricCsvValues,
  hasReferenceSolution,
  hasRubric,
  resolveEvaluationMode,
  rubricRequiresSubmittedSolution,
} from '../../utils/rubricEvaluation.js';
import axios from 'axios';

function normalizeProcess(process) {
  if (!Array.isArray(process)) return '';
  return process
    .map((value) => String(value).trim())
    .filter(Boolean)
    .sort()
    .join('|');
}

function validateMultiLeiaProcesses(experiment) {
  const leias = experiment?.leias || [];
  const problemLeiaId =
    experiment?.orchestration?.problemLeiaId ||
    experiment?.orchestration?.openingLeiaId ||
    leias[0]?.id;
  const problemLeia = leias.find(
    (entry) => String(entry.id) === String(problemLeiaId)
  );
  if (!problemLeia) {
    const error = new Error('Shared problem LEIA must belong to the MultiLEIA activity');
    error.statusCode = 400;
    throw error;
  }
  const sharedProcess = normalizeProcess(
    problemLeia.leia?.spec?.problem?.spec?.process
  );
  if (
    leias.some(
      (entry) =>
        normalizeProcess(entry.leia?.spec?.behaviour?.spec?.process) !== sharedProcess
    )
  ) {
    const error = new Error('Every MultiLEIA behaviour must use the shared problem process');
    error.statusCode = 400;
    throw error;
  }
}

class ReplicationService {
  async updateDataUsage(id, config) {
    return await ReplicationRepository.update(id, {
      dataUsageConfig: {
        ...config,
        conversationAutomatedRemoval: config.dataUsageConsentRequired && config.conversationAutomatedRemoval,
      },
    });
  }
  // READ METHODS

  async findAll(lastReplicationId, text) {
    return await ReplicationRepository.findAll(lastReplicationId, text);
  }
  async findAllByUser(userId, lastReplicationId, text) {
    return await ReplicationRepository.findAllByUser(userId, lastReplicationId, text);
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

  _validateExperimentForReplication(experiment) {
    if (!experiment) {
      const error = new Error('Experiment not found');
      error.statusCode = 404;
      throw error;
    }
    for (const flow of activityFlows(experiment)) {
      if (flow.orchestration?.mode !== 'multi') continue;
      const leias = flow.leias || [];
      if (leias.length < 2) {
        const error = new Error('MultiLEIA requires at least two LEIAs');
        error.statusCode = 400;
        throw error;
      }
      if (leias.some((entry) => entry.configuration?.mode === 'transcription')) {
        const error = new Error('MultiLEIA currently supports standard text mode only');
        error.statusCode = 400;
        throw error;
      }
      validateMultiLeiaProcesses(flow);
    }
  }

  async create(replicationData, authorization, apiKeyRequesterId) {
    const experiment = await ManagerService.findExperimentById(
      replicationData.experiment,
      authorization
    );
    this._validateExperimentForReplication(experiment);
    const defaultApiKey = await this.getDefaultApiKey(authorization);
    let initializedDefaultApiKey = defaultApiKey;
    let providerDriver = 'default';
    if (defaultApiKey) {
      const providerConfiguration = await this.getProviderAndProviderModuleForReplication(
        defaultApiKey.model,
        defaultApiKey.provider
      );
      providerDriver = providerConfiguration.providerDriver;
      initializedDefaultApiKey = {
        ...defaultApiKey,
        model: providerConfiguration.modelName,
      };
    }
    const initializedExperiment = initializeExperiment(
      experiment,
      initializedDefaultApiKey,
      apiKeyRequesterId,
      providerDriver
    );
    replicationData.experiment = initializedExperiment;
    replicationData.user = apiKeyRequesterId;
    return await ReplicationRepository.create(replicationData);
  }

  async getDefaultApiKey(authorization) {
    if (!authorization) return null;

    const response = await axios.get(`${process.env.AUTH_URL}/api/v1/apikeys`, {
      headers: { Authorization: authorization },
    });
    return response.data.find((apiKey) => apiKey.isDefault) || null;
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
      for (const flow of activityFlows(replication.experiment)) {
        if (flow.orchestration?.mode !== 'multi') continue;
        const leias = flow.leias || [];
        if (leias.length < 2) {
          const error = new Error('MultiLEIA requires at least two LEIAs');
          error.statusCode = 400;
          throw error;
        }
        if (leias.some((leia) => Boolean(leia.runnerConfiguration?.audioMode))) {
          const error = new Error('MultiLEIA currently supports text mode only');
          error.statusCode = 400;
          throw error;
        }
        validateMultiLeiaProcesses(flow);
      }
      const stagesRequiringSolution = getStagesRequiringSolution(replication.experiment);
      for (const [sourceStageId, dependentStages] of stagesRequiringSolution.entries()) {
        const stageIndex = replication.experiment.stages.findIndex(({ id: stageId }) => stageId === sourceStageId);
        const sourceStage = replication.experiment.stages[stageIndex];
        const stageLeias = replication.experiment.leias.filter((entry) => entry.stageId === sourceStageId);
        const targetLeias = sourceStage?.orchestration?.mode === 'multi'
          ? [getStageProblemLeia(replication.experiment, sourceStage)].filter(Boolean)
          : stageLeias;
        if (targetLeias.some((entry) => entry.configuration?.askSolution === false)) {
          const stageList = dependentStages.map((n) => `Stage ${n}`).join(', ');
          throw activityError(
            `Stage ${stageIndex + 1} requires "Ask for student solution" to be enabled because ${stageList} uses its submitted solution`
          );
        }
      }
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

  async updateExperiment(id, experimentId, authorization) {
    if (SessionRepository.hasReplicationStarted(id)) {
      const error = new Error('Replication has already started, cannot update experiment');
      error.status = 400;
      throw error;
    }
    const experiment = await ManagerService.findExperimentById(experimentId, authorization);
    this._validateExperimentForReplication(experiment);
    const initializedExperiment = initializeExperiment(experiment);
    return await ReplicationRepository.update(id, { initializedExperiment });
  }

  async updateLeiaRunnerConfiguration(id, leiaId, runnerConfiguration) {
    if (runnerConfiguration.audioMode) {
      const replication = await ReplicationRepository.findById(id);
      const experiment = replication?.experiment;
      const entry = experiment?.leias.find((leia) => String(leia.id) === String(leiaId));
      const stage = experiment?.stages?.find(({ id: stageId }) => stageId === entry?.stageId);
      if (stage?.orchestration?.mode === 'multi') {
        throw activityError('MultiLEIA stages support text mode only');
      }
    }
    return await ReplicationRepository.updateLeiaRunnerConfiguration(id, leiaId, runnerConfiguration);
  }

  async getAndIncrementNextLeia(id) {
    return await ReplicationRepository.getAndIncrementNextLeia(id);
  }

  async recordStageAssignment(replicationId, leiaId) {
    return await ReplicationRepository.incrementLeiaSessionCount(replicationId, leiaId);
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
    const replication = await ReplicationRepository.findById(id);
    const leia = replication?.experiment?.leias?.find((entry) => String(entry.id) === String(leiaId));
    if (!leia) {
      const error = new Error('Leia not found');
      error.statusCode = 404;
      throw error;
    }

    const stage = replication.experiment?.stages?.find(({ id: stageId }) => stageId === leia.stageId);
    if (stage?.orchestration?.mode === 'multi') {
      const problemLeia = getStageProblemLeia(replication.experiment, stage);
      if (problemLeia && String(problemLeia.id) !== String(leia.id)) {
        throw activityError('Configure solution settings on the shared problem LEIA for MultiLEIA stages');
      }
    }

    const askSolutionStatus = !leia.configuration.askSolution;
    const evaluationMode = resolveEvaluationMode(leia.configuration);

    if (!askSolutionStatus) {
      const dependentStages = getSolutionRequirementForLeia(replication.experiment, leia);
      if (dependentStages) {
        const stageList = dependentStages.map((n) => `Stage ${n}`).join(', ');
        throw activityError(
          `Ask for student solution cannot be disabled because ${stageList} uses this stage's submitted solution`
        );
      }
      if (evaluationMode === 'rubric' && rubricRequiresSubmittedSolution(leia)) {
        throw activityError(
          'Ask for student solution cannot be disabled because the rubric evaluation prompt references the submitted solution'
        );
      }
    }

    if (!askSolutionStatus && evaluationMode === 'classic') {
      return await ReplicationRepository.updateAskSolutionAndEvaluateSolution(
        id,
        leiaId,
        false,
        false
      );
    }
    if (!askSolutionStatus && evaluationMode === 'rubric') {
      return await ReplicationRepository.updateAskSolution(id, leiaId, askSolutionStatus, {
        clearShowSolution: false,
      });
    }
    return await ReplicationRepository.updateAskSolution(id, leiaId, askSolutionStatus);
  }

  async updateEvaluationMode(id, leiaId, evaluationMode) {
    if (!['none', 'classic', 'rubric'].includes(evaluationMode)) {
      throw activityError("Invalid evaluation mode. Expected 'none', 'classic', or 'rubric'");
    }
    const replication = await ReplicationRepository.findById(id);
    const leia = replication?.experiment?.leias?.find((entry) => String(entry.id) === String(leiaId));
    if (!leia) {
      const error = new Error('Leia not found');
      error.status = 404;
      error.statusCode = 404;
      throw error;
    }

    const stage = replication.experiment?.stages?.find(({ id: stageId }) => stageId === leia.stageId);
    if (stage?.orchestration?.mode === 'multi') {
      const problemLeia = getStageProblemLeia(replication.experiment, stage);
      if (problemLeia && String(problemLeia.id) !== String(leia.id)) {
        throw activityError('Configure solution settings on the shared problem LEIA for MultiLEIA stages');
      }
    }

    if (evaluationMode === 'classic') {
      if (!hasReferenceSolution(leia)) {
        throw activityError('Classic evaluation requires a reference solution in the problem definition');
      }
      return await ReplicationRepository.updateEvaluationConfiguration(id, leiaId, {
        evaluationMode: 'classic',
        evaluateSolution: true,
        ...(leia.configuration.askSolution ? {} : { askSolution: true }),
      });
    }

    if (evaluationMode === 'rubric') {
      if (!hasRubric(leia)) {
        throw activityError('Rubric evaluation requires a rubric in the LEIA definition');
      }
      const needsSolution = rubricRequiresSubmittedSolution(leia);
      return await ReplicationRepository.updateEvaluationConfiguration(id, leiaId, {
        evaluationMode: 'rubric',
        evaluateSolution: true,
        ...(needsSolution && !leia.configuration.askSolution ? { askSolution: true } : {}),
      });
    }

    const updates = {
      evaluationMode: 'none',
      evaluateSolution: false,
    };
    if (!leia.configuration.askSolution) {
      updates.showSolution = false;
    }
    return await ReplicationRepository.updateEvaluationConfiguration(id, leiaId, updates);
  }

  async toggleEvaluateSolution(id, leiaId) {
    const replication = await ReplicationRepository.findById(id);
    const leia = replication?.experiment?.leias?.find((entry) => String(entry.id) === String(leiaId));
    if (!leia) {
      const error = new Error('Leia not found');
      error.status = 404;
      error.statusCode = 404;
      throw error;
    }

    const currentMode = resolveEvaluationMode(leia.configuration);
    if (currentMode !== 'none') {
      return await this.updateEvaluationMode(id, leiaId, 'none');
    }
    if (hasReferenceSolution(leia)) {
      return await this.updateEvaluationMode(id, leiaId, 'classic');
    }
    if (hasRubric(leia)) {
      return await this.updateEvaluationMode(id, leiaId, 'rubric');
    }
    throw activityError('Automatic evaluation requires a reference solution in the problem definition');
  }

  async toggleShowSolution(id, leiaId) {
    const replication = await ReplicationRepository.findById(id);
    const leia = replication?.experiment?.leias?.find((entry) => String(entry.id) === String(leiaId));
    if (!leia) {
      const error = new Error('Leia not found');
      error.status = 404;
      error.statusCode = 404;
      throw error;
    }

    const stage = replication.experiment?.stages?.find(({ id: stageId }) => stageId === leia.stageId);
    if (stage?.orchestration?.mode === 'multi') {
      const problemLeia = getStageProblemLeia(replication.experiment, stage);
      if (problemLeia && String(problemLeia.id) !== String(leia.id)) {
        throw activityError('Configure solution settings on the shared problem LEIA for MultiLEIA stages');
      }
    }

    const evaluationMode = resolveEvaluationMode(leia.configuration);
    const askSolutionStatus = Boolean(leia.configuration.askSolution);
    const canShowWithoutAsk = evaluationMode === 'rubric';
    const currentShowSolution = (askSolutionStatus || canShowWithoutAsk) && leia.configuration.showSolution !== false;
    const showSolutionStatus = !currentShowSolution;

    if (showSolutionStatus) {
      if (!hasReferenceSolution(leia) && evaluationMode !== 'rubric') {
        throw activityError('Showing the reference solution requires a reference solution in the problem definition');
      }
    }

    if (!askSolutionStatus && showSolutionStatus && evaluationMode !== 'rubric') {
      return await ReplicationRepository.updateAskSolutionAndShowSolution(
        id,
        leiaId,
        true,
        showSolutionStatus
      );
    }
    return await ReplicationRepository.updateShowSolution(id, leiaId, showSolutionStatus);
  }

  _resolvePreviousStageResourceUpdate(
    replication,
    stageIndex,
    existingConfig,
    incoming,
    { label, requireAskSolution = false }
  ) {
    const stages = replication.experiment.stages;
    const existing = existingConfig || {};
    const nextAvailability =
      incoming.availability !== undefined
        ? incoming.availability
        : PREVIOUS_STAGE_VIEW_AVAILABILITIES.includes(existing.availability)
          ? existing.availability
          : 'both';
    if (!PREVIOUS_STAGE_VIEW_AVAILABILITIES.includes(nextAvailability)) {
      throw activityError("Invalid availability. Expected 'chat', 'editor', or 'both'", 400);
    }

    const nextSourceStageId =
      incoming.sourceStageId !== undefined ? incoming.sourceStageId : (existing.sourceStageId ?? null);

    let sourceStage = null;
    let sourceIndex = -1;
    if (nextSourceStageId !== null) {
      sourceIndex = stages.findIndex((stage) => stage.id === nextSourceStageId);
      if (sourceIndex === -1 || !(sourceIndex < stageIndex)) {
        throw activityError(`The source stage for previous ${label} must be an earlier stage`, 400);
      }
      sourceStage = stages[sourceIndex];
    }

    const enabled = Boolean(incoming.enabled);
    if (enabled && !nextSourceStageId) {
      throw activityError(`Select an earlier stage for the previous ${label}`, 400);
    }

    if (enabled && requireAskSolution && !stageHasAskSolutionEnabled(replication.experiment, sourceStage)) {
      throw activityError(
        `Stage ${sourceIndex + 1} must have "Ask for student solution" enabled to show its submitted solution`,
        400
      );
    }

    return {
      enabled,
      sourceStageId: nextSourceStageId,
      availability: nextAvailability,
    };
  }

  async updateStagePreviousConversation(id, stageId, { enabled, sourceStageId, availability } = {}) {
    const replication = await ReplicationRepository.findById(id);
    if (!replication) {
      throw activityError('Replication not found', 404);
    }

    const stages = replication.experiment?.stages;
    if (!Array.isArray(stages)) {
      throw activityError('Stage not found', 404);
    }

    const stageIndex = stages.findIndex((stage) => stage.id === stageId);
    if (stageIndex === -1) {
      throw activityError('Stage not found', 404);
    }

    if (stageIndex === 0) {
      throw activityError('Previous conversation is only available for stages after the first stage', 400);
    }

    const resolved = this._resolvePreviousStageResourceUpdate(
      replication,
      stageIndex,
      stages[stageIndex].previousConversation,
      { enabled, sourceStageId, availability },
      { label: 'conversation' }
    );

    return await ReplicationRepository.updateStagePreviousConversation(id, stageId, resolved);
  }

  async updateLeiaPreviousStageView(
    id,
    leiaId,
    { previousConversation, previousSubmittedSolution, applyToStage = false } = {}
  ) {
    const replication = await ReplicationRepository.findById(id);
    if (!replication) {
      throw activityError('Replication not found', 404);
    }

    const leia = replication.experiment?.leias?.find(
      (entry) => String(entry.id) === String(leiaId)
    );
    if (!leia) {
      throw activityError('Leia not found', 404);
    }

    const stages = replication.experiment?.stages;
    if (!Array.isArray(stages) || !leia.stageId) {
      throw activityError('Previous stage view is only available for multi-stage activities', 400);
    }

    const stageIndex = stages.findIndex((stage) => stage.id === leia.stageId);
    if (stageIndex === -1) {
      throw activityError('Stage not found', 404);
    }

    if (stageIndex === 0) {
      throw activityError(
        'Previous stage view is only available for stages after the first stage',
        400
      );
    }

    const stage = stages[stageIndex];
    const isMulti = stage.orchestration?.mode === 'multi';
    if (isMulti) {
      const problemLeia = getStageProblemLeia(replication.experiment, stage);
      if (problemLeia && String(problemLeia.id) !== String(leia.id)) {
        throw activityError(
          'Configure previous stage view settings on the shared problem LEIA for MultiLEIA stages',
          400
        );
      }
    }

    const existingPrevConv =
      leia.configuration?.previousConversation !== undefined
        ? leia.configuration.previousConversation
        : stage.previousConversation;
    const existingPrevSol =
      leia.configuration?.previousSubmittedSolution !== undefined
        ? leia.configuration.previousSubmittedSolution
        : stage.previousSubmittedSolution;

    const updates = {};
    if (previousConversation !== undefined) {
      updates.previousConversation = this._resolvePreviousStageResourceUpdate(
        replication,
        stageIndex,
        existingPrevConv,
        previousConversation,
        { label: 'conversation' }
      );
    }

    if (previousSubmittedSolution !== undefined) {
      updates.previousSubmittedSolution = this._resolvePreviousStageResourceUpdate(
        replication,
        stageIndex,
        existingPrevSol,
        previousSubmittedSolution,
        { label: 'submitted solution', requireAskSolution: true }
      );
    }

    const finalPrevConv = updates.previousConversation ?? existingPrevConv;
    const finalPrevSol = updates.previousSubmittedSolution ?? existingPrevSol;
    if (
      finalPrevConv?.enabled &&
      finalPrevSol?.enabled &&
      finalPrevConv.sourceStageId !== finalPrevSol.sourceStageId
    ) {
      throw activityError(
        'Conversation and submitted solution buttons must use the same source stage',
        400
      );
    }

    if (applyToStage && !isMulti) {
      return await ReplicationRepository.updateStageLeiasPreviousStageView(id, stage.id, updates);
    }

    return await ReplicationRepository.updateLeiaPreviousStageView(id, leiaId, updates);
  }

  async getConversations(id) {
    const [replication, sessions] = await Promise.all([
      ReplicationRepository.findById(id),
      SessionRepository.findByReplicationAndPopulateMessages(id),
    ]);
    const stages = replication?.experiment?.stages || [];
    const stageIndexById = new Map(stages.map(({ id: stageId }, index) => [stageId, index]));
    const stageTotal = stages.length || null;

    return sessions.map((session) => {
      const data = typeof session.toJSON === 'function' ? session.toJSON() : { ...session };
      const resolvedStageIndex =
        typeof data.stageIndex === 'number'
          ? data.stageIndex
          : data.stageId && stageIndexById.has(data.stageId)
            ? stageIndexById.get(data.stageId)
            : null;
      return {
        ...data,
        runId: data.run ? String(data.run) : null,
        stageNumber: resolvedStageIndex !== null ? resolvedStageIndex + 1 : null,
        stageTotal,
      };
    });
  }

  async getConversationsCSV(id) {
    const [replication, storedSessions] = await Promise.all([
      ReplicationRepository.findById(id),
      SessionRepository.findByReplicationAndPopulateMessages(id),
    ]);
    const sessions = storedSessions.filter((session) => session.dataUsage?.consentStatus !== 'declined');
    const stages = replication?.experiment?.stages || [];
    const stageIndexById = new Map(stages.map(({ id: stageId }, index) => [stageId, index]));
    const leiaNameById = new Map();
    for (const entry of replication?.experiment?.leias || []) {
      const name = entry?.leia?.metadata?.name || String(entry?.id || '');
      if (entry?.id) leiaNameById.set(String(entry.id), name);
      if (entry?.leia?.id) leiaNameById.set(String(entry.leia.id), name);
    }
    const escapeCsv = (value) => {
      if (value === undefined || value === null || value === '') return '';
      const str = String(value);
      return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const runKeyOf = (session) => (session.run ? String(session.run) : String(session.id || ''));
    const runStartByKey = new Map();
    for (const session of sessions) {
      const key = runKeyOf(session);
      const ts = new Date(session.startedAt || 0).getTime();
      const prev = runStartByKey.get(key);
      if (prev === undefined || ts < prev) {
        runStartByKey.set(key, ts);
      }
    }

    const sortedSessions = [...sessions].sort((a, b) => {
      const runA = runKeyOf(a);
      const runB = runKeyOf(b);
      if (runA !== runB) {
        const diff = (runStartByKey.get(runA) ?? 0) - (runStartByKey.get(runB) ?? 0);
        return diff !== 0 ? diff : runA.localeCompare(runB);
      }
      const idxA =
        typeof a.stageIndex === 'number'
          ? a.stageIndex
          : stageIndexById.get(a.stageId) ?? 0;
      const idxB =
        typeof b.stageIndex === 'number'
          ? b.stageIndex
          : stageIndexById.get(b.stageId) ?? 0;
      if (idxA !== idxB) return idxA - idxB;
      return new Date(a.startedAt || 0).getTime() - new Date(b.startedAt || 0).getTime();
    });

    const rubricColumns = collectRubricCsvColumns(replication, sortedSessions);
    const baseHeaders = [
      'Session ID',
      'Run ID',
      'Stage',
      'LEIA',
      'User',
      'Started At',
      'Finished At',
      'Message',
      'Is LEIA',
      'Sender',
      'Timestamp',
      'Evaluation Mode',
      'Score',
      'Evaluation',
      'Submitted Solution',
      ...rubricColumns.map((col) => col.header),
    ];
    let csv = `${baseHeaders.map(escapeCsv).join(',')}\n`;

    for (const session of sortedSessions) {
      const sessionId = session.id || '';
      const runId = session.run ? String(session.run) : '';
      const resolvedStageIndex =
        typeof session.stageIndex === 'number'
          ? session.stageIndex
          : session.stageId && stageIndexById.has(session.stageId)
            ? stageIndexById.get(session.stageId)
            : null;
      const stageLabel =
        resolvedStageIndex !== null
          ? `${resolvedStageIndex + 1}/${stages.length || resolvedStageIndex + 1}`
          : '';
      const leiaName = leiaNameById.get(String(session.leia || '')) || String(session.leia || '');
      const userId = session.user?.email || session.user?.id || 'Anonymous';
      const startedAt = session.startedAt ? new Date(session.startedAt).toISOString() : '';
      const finishedAt = session.finishedAt ? new Date(session.finishedAt).toISOString() : '';
      const evaluationMode =
        session.evaluationMode || (session.rubricEvaluation ? 'rubric' : session.evaluation ? 'classic' : '');
      const score = session.score ?? '';
      const evaluation = escapeCsv(session.evaluation);
      const submittedSolution = escapeCsv(session.result);
      const rubricCells = extractRubricCsvValues(session.rubricEvaluation, rubricColumns)
        .map(escapeCsv)
        .join(',');
      const rubricSuffix = rubricColumns.length ? `,${rubricCells}` : '';

      if (session.messages && session.messages.length > 0) {
        for (const message of session.messages) {
          const messageText = escapeCsv(message.text);
          const isLeia = message.isLeia ? 'TRUE' : 'FALSE';
          const sender = escapeCsv(message.senderName || (message.isLeia ? leiaName : 'Participant'));
          const timestamp = message.timestamp ? new Date(message.timestamp).toISOString() : '';

          csv += `${escapeCsv(sessionId)},${escapeCsv(runId)},${escapeCsv(stageLabel)},${escapeCsv(leiaName)},${escapeCsv(userId)},${startedAt},${finishedAt},${messageText},${isLeia},${sender},${timestamp},${escapeCsv(evaluationMode)},${score},${evaluation},${submittedSolution}${rubricSuffix}\n`;
        }
      } else {
        csv += `${escapeCsv(sessionId)},${escapeCsv(runId)},${escapeCsv(stageLabel)},${escapeCsv(leiaName)},${escapeCsv(userId)},${startedAt},${finishedAt},"No messages",,,,${escapeCsv(evaluationMode)},${score},${evaluation},${submittedSolution}${rubricSuffix}\n`;
      }
    }

    return csv;
  }

  async getProviderAndProviderModuleForReplication(modelName, preferredProvider = null) {
    const {data} = await axios.get(`${process.env.RUNNER_URL}/api/v1/models`, {
      headers: {
        Authorization: 'Bearer ' + process.env.RUNNER_KEY,
      },
    });
    let resolvedModelName =
      typeof modelName === 'string' && modelName.trim() ? modelName.trim() : null;
    let provider = resolvedModelName
      ? Object.entries(data.apiKeyProviders || {})
          .find(([, models]) => models.includes(resolvedModelName))?.[0]
      : null;

    // API keys created before the model field was introduced still carry a
    // provider. Pick that provider's first available model so old defaults do
    // not prevent a replication from being created.
    if (!resolvedModelName && preferredProvider) {
      const providerModels = data.apiKeyProviders?.[preferredProvider];
      if (Array.isArray(providerModels) && providerModels.length > 0) {
        provider = preferredProvider;
        resolvedModelName = providerModels[0];
      }
    }

    if (!provider || !resolvedModelName) {
      const error = new Error(
        resolvedModelName
          ? `Model '${resolvedModelName}' not mapped to provider`
          : `No model is available for provider '${preferredProvider || 'unknown'}'`
      );
      error.statusCode = 400;
      throw error;
    }
    const providerDriver = data.providerProviderModuleMap?.[provider];
    if (!providerDriver) {
      const error = new Error(`No provider module for provider '${provider}'`);
      error.statusCode = 400;
      throw error;
    }

    return { provider, providerDriver, modelName: resolvedModelName };
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

  async updateLanguage(id, language) {
    return await ReplicationRepository.update(id, { language });
  } 
}

export default new ReplicationService();
