import InteractionService from '../../services/v1/InteractionService.js';
import ReplicationService from '../../services/v1/ReplicationService.js';
import {
  startSessionValidator,
  sendSessionMessageValidator,
  saveResultAndFinishSessionValidator,
  startTestSessionValidator,
  saveDraftValidator,
} from '../../validators/v1/interactionValidator.js';

export const startSession = async (req, res, next) => {
  try {
    const value = await startSessionValidator.validateAsync(req.body);
    const sessionId = await InteractionService.startSession(value.email, value.code);
    res.status(201).json({ sessionId });
  } catch (error) {
    next(error);
  }
};

export const startTestSession = async (req, res, next) => {
  try {
    const { replicationId, leiaId } = await startTestSessionValidator.validateAsync(req.body);
    await ReplicationService.checkAccess(replicationId, req.user.isAdmin, req.user.shareToken);
    const sessionId = await InteractionService.startTestSession(replicationId, leiaId);
    res.status(201).json({ sessionId });
  } catch (error) {
    next(error);
  }
};

export const getSessionData = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const data = await InteractionService.getSessionData(sessionId);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

export const sendSessionMessage = async (req, res, next) => {
  try {
    const value = await sendSessionMessageValidator.validateAsync(req.body);
    const { sessionId } = req.params;
    const message = await InteractionService.sendSessionMessage(sessionId, value.message);
    res.json({ message });
  } catch (error) {
    next(error);
  }
};

export const saveResultAndFinishSession = async (req, res, next) => {
  try {
    const value = await saveResultAndFinishSessionValidator.validateAsync(req.body);
    const { sessionId } = req.params;
    const session = await InteractionService.saveResultAndFinishSession(sessionId, value.result);
    res.json(session);
  } catch (error) {
    next(error);
  }
};

export const finishSession = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const session = await InteractionService.finishSession(sessionId);
    res.json(session);
  } catch (error) {
    next(error);
  }
};

export const saveDraft = async (req, res, next) => {
  try {
    const value = await saveDraftValidator.validateAsync(req.body);
    const { sessionId } = req.params;
    const session = await InteractionService.saveDraft(sessionId, value.draft);
    res.json(session);
  } catch (error) {
    next(error);
  }
};

export const getEvaluation = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const evaluation = await InteractionService.getEvaluation(sessionId);
    res.json(evaluation);
  } catch (error) {
    next(error);
  }
};

export const getSolution = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const res = await InteractionService.getSolutionAndFormat(sessionId);
    res.json(res);
  } catch (error) {
    next(error);
  }
};
