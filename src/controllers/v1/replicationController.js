import ReplicationService from '../../services/v1/ReplicationService.js';
import SessionService from '../../services/v1/SessionService.js';
import {
  createReplicationValidator,
  updateReplicationNameValidator,
  updateReplicationDurationValidator,
  updateReplicationExperimentValidator,
  updateReplicationLeiaRunnerConfigurationValidator,
  updateReplicationFormValidator,
  updateSessionScoreValidator,
} from '../../validators/v1/replicationValidator.js';

export const createReplication = async (req, res, next) => {
  try {
    const value = await createReplicationValidator.validateAsync(req.body, {
      abortEarly: false,
    });
    const newReplication = await ReplicationService.create(value);
    res.status(201).json(newReplication);
  } catch (err) {
    next(err);
  }
};

export const getReplicationById = async (req, res, next) => {
  try {
    const replication = await ReplicationService.findById(req.params.id);
    res.json(replication);
  } catch (err) {
    next(err);
  }
};

export const getAllReplications = async (req, res, next) => {
  try {
    const replications = await ReplicationService.findAll();
    res.json(replications);
  } catch (err) {
    next(err);
  }
};

export const updateReplicationName = async (req, res, next) => {
  try {
    const value = await updateReplicationNameValidator.validateAsync(req.body, {
      abortEarly: false,
    });
    const updatedReplication = await ReplicationService.updateName(req.params.id, value.name);
    res.json(updatedReplication);
  } catch (err) {
    next(err);
  }
};

export const regenerateReplicationCode = async (req, res, next) => {
  try {
    const updatedReplication = await ReplicationService.regenerateCode(req.params.id);
    res.json(updatedReplication);
  } catch (err) {
    next(err);
  }
};

export const toggleReplicationIsActive = async (req, res, next) => {
  try {
    const updatedReplication = await ReplicationService.toggleIsActive(req.params.id);
    res.json(updatedReplication);
  } catch (err) {
    next(err);
  }
};

export const toggleReplicationIsRepeatable = async (req, res, next) => {
  try {
    const updatedReplication = await ReplicationService.toggleIsRepeatable(req.params.id);
    res.json(updatedReplication);
  } catch (err) {
    next(err);
  }
};

export const updateReplicationDuration = async (req, res, next) => {
  try {
    const value = await updateReplicationDurationValidator.validateAsync(req.body, { abortEarly: false });
    const updatedReplication = await ReplicationService.updateDuration(req.params.id, value.duration);
    res.json(updatedReplication);
  } catch (err) {
    next(err);
  }
};

export const updateReplicationExperiment = async (req, res, next) => {
  try {
    const value = await updateReplicationExperimentValidator.validateAsync(req.body, { abortEarly: false });
    const updatedReplication = await ReplicationService.updateExperiment(req.params.id, value.experiment);
    res.json(updatedReplication);
  } catch (err) {
    next(err);
  }
};

export const updateReplicationLeiaRunnerConfiguration = async (req, res, next) => {
  try {
    const { id, leiaId } = req.params;
    const value = await updateReplicationLeiaRunnerConfigurationValidator.validateAsync(req.body, {
      abortEarly: false,
    });
    const updatedReplication = await ReplicationService.updateLeiaRunnerConfiguration(id, leiaId, value);
    res.json(updatedReplication);
  } catch (err) {
    next(err);
  }
};

export const updateReplicationForm = async (req, res, next) => {
  try {
    const { id } = req.params;
    const value = await updateReplicationFormValidator.validateAsync(req.body, { abortEarly: false });
    const updatedReplication = await ReplicationService.updateForm(id, value.form);
    res.json(updatedReplication);
  } catch (err) {
    next(err);
  }
};

export const deleteReplicationForm = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updatedReplication = await ReplicationService.deleteForm(id);
    res.json(updatedReplication);
  } catch (err) {
    next(err);
  }
};

export const toggleAskSolution = async (req, res, next) => {
  try {
    const { id, leiaId } = req.params;
    const updatedReplication = await ReplicationService.toggleAskSolution(id, leiaId);
    res.json(updatedReplication);
  } catch (err) {
    next(err);
  }
};

export const toggleEvaluateSolution = async (req, res, next) => {
  try {
    const { id, leiaId } = req.params;
    const updatedReplication = await ReplicationService.toggleEvaluateSolution(id, leiaId);
    res.json(updatedReplication);
  } catch (err) {
    next(err);
  }
};

export const getReplicationConversations = async (req, res, next) => {
  try {
    const conversations = await ReplicationService.getConversations(req.params.id);
    res.json(conversations);
  } catch (err) {
    next(err);
  }
};

export const downloadReplicationConversationsCSV = async (req, res, next) => {
  try {
    const csv = await ReplicationService.getConversationsCSV(req.params.id);
    const replication = await ReplicationService.findById(req.params.id);
    const filename = `${replication.name.replace(/\s+/g, '_')}_conversations.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

export const updateSessionScore = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const value = await updateSessionScoreValidator.validateAsync(req.body, { abortEarly: false });
    const updatedSession = await SessionService.saveScore(sessionId, value.score);
    res.json(updatedSession);
  } catch (err) {
    next(err);
  }
};
