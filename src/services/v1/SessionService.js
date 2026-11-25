import SessionRepository from '../../repositories/v1/SessionRepository.js';
import ReplicationService from './ReplicationService.js';
import { emitToSession, emitToReplication } from '../../socket/index.js';
import { activityError } from '../../utils/activityStages.js';

class SessionService {
  // READ METHODS

  async findAll() {
    return await SessionRepository.findAll();
  }

  async findById(id) {
    return await SessionRepository.findById(id);
  }

  async findByIdAndPopulateMessages(id) {
    return await SessionRepository.findByIdAndPopulateMessages(id);
  }

  async findByReplication(replicationId) {
    return await SessionRepository.findByReplication(replicationId);
  }

  async findByReplicationAndLeia(replicationId, leiaId) {
    return await SessionRepository.findByReplicationAndLeia(replicationId, leiaId);
  }

  async findFinishedByReplication(replicationId) {
    return await SessionRepository.findFinishedByReplication(replicationId);
  }

  async checkReplicationAccess(sessionId, isAdmin, token) {
    const session = await this.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.status = 404;
      throw error;
    }
    await ReplicationService.checkAccess(session.replication.toString(), isAdmin, token);
  }

  // Indexed
  async findByUser(userId) {
    return await SessionRepository.findByUser(userId);
  }
  async findByUserAndReplication(userId, replicationId) {
    return await SessionRepository.findByUserAndReplication(userId, replicationId);
  }
  async findOneUnfinishedByUserAndReplication(userId, replicationId) {
    return await SessionRepository.findOneUnfinishedByUserAndReplication(userId, replicationId);
  }
  async hasAnyFinished(userId, replicationId) {
    return await SessionRepository.hasAnyFinished(userId, replicationId);
  }

  // WRITE METHODS

  async create(userId, replicationId, leiaId, isTest = false, options = {}) {
    const sessionData = {
      user: userId,
      replication: replicationId,
      leia: leiaId,
      isTest,
      interactionMode: options.interactionMode || 'single',
    };
    if (options.dataUsage) sessionData.dataUsage = options.dataUsage;
    if (Array.isArray(options.leias) && options.leias.length > 0) {
      sessionData.leias = options.leias;
    }
    if (options.multiLeiaState) {
      sessionData.multiLeiaState = options.multiLeiaState;
    }
    return await SessionRepository.create(sessionData);
  }

  async finish(id, conversationRemovalDueAt) {
    const session = await SessionRepository.update(id, {
      finishedAt: new Date(),
      ...(conversationRemovalDueAt ? { conversationRemovalDueAt } : {}),
    });
    this.emitFinished(id, session);
    return session;
  }

  async finishStage(id, result, conversationRemovalDueAt) {
    const changes = {
      finishedAt: new Date(),
      ...(result !== undefined ? { result } : {}),
      ...(conversationRemovalDueAt ? { conversationRemovalDueAt } : {}),
    };
    const session = await SessionRepository.finishStage(id, changes);
    if (session) {
      this.emitFinished(id, session);
      return session;
    }
    const existing = await this.findById(id);
    if (existing?.finishedAt && (result === undefined || existing.result === result)) return existing;
    throw activityError('Stage already finished', 409);
  }

  emitFinished(id, session) {
    // Emit WebSocket event
    try {
      emitToSession(id, 'session:finished', { sessionId: id, finishedAt: session.finishedAt });
      emitToReplication(session.replication.toString(), 'session:finished', {
        sessionId: id,
        finishedAt: session.finishedAt,
      });
    } catch (error) {
      console.error('Failed to emit session finished via WebSocket:', error);
    }

  }

  async saveResult(id, result) {
    return await SessionRepository.update(id, { result });
  }

  async saveResultAndFinish(id, result, conversationRemovalDueAt) {
    return await SessionRepository.update(id, {
      result,
      finishedAt: new Date(),
      ...(conversationRemovalDueAt ? { conversationRemovalDueAt } : {}),
    });
  }

  async saveEvaluation(id, evaluation) {
    return await SessionRepository.update(id, { evaluation });
  }

  async saveScore(id, score) {
    return await SessionRepository.update(id, { score });
  }

  async saveEvaluationAndScore(id, evaluation, score, details = {}) {
    const updates = {
      score,
      evaluation,
      ...(details.evaluationMode ? { evaluationMode: details.evaluationMode } : {}),
      ...(details.rubricEvaluation !== undefined ? { rubricEvaluation: details.rubricEvaluation } : {}),
    };
    const updated = await SessionRepository.update(id, updates);
    if (updated) {
      this.emitEvaluated(id, updated);
    }
    return updated;
  }

  emitEvaluated(id, session) {
    try {
      const payload = {
        sessionId: id,
        score: session.score,
        evaluationMode: session.evaluationMode || (session.rubricEvaluation ? 'rubric' : 'classic'),
        evaluation: session.evaluation,
        ...(session.rubricEvaluation ? { rubricEvaluation: session.rubricEvaluation } : {}),
      };
      emitToSession(id, 'session:evaluated', payload);
      if (session.replication) {
        emitToReplication(session.replication.toString(), 'session:evaluated', payload);
      }
    } catch (error) {
      console.error('Failed to emit session evaluated via WebSocket:', error);
    }
  }

  async addMessage(id, messageId) {
    return await SessionRepository.addMessage(id, messageId);
  }

  async updateIsRunnerInitialized(id, isRunnerInitialized) {
    return await SessionRepository.update(id, { isRunnerInitialized });
  }

  async updateMultiLeiaState(id, multiLeiaState) {
    return await SessionRepository.update(id, { multiLeiaState });
  }

  async saveDraft(id, draft) {
    return await SessionRepository.update(id, { draft });
  }

  async appendSupervisorObservation(id, flags, supervisorState) {
    return await SessionRepository.appendSupervisorObservation(id, flags, supervisorState);
  }

  async clearPendingNudge(id, value) {
    return await SessionRepository.clearPendingNudge(id, value);
  }
}

export default new SessionService();
