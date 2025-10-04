import SessionRepository from '../../repositories/v1/SessionRepository.js';
import { emitToSession, emitToReplication } from '../../socket/index.js';

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

  async create(userId, replicationId, leiaId, isTest = false) {
    const sessionData = {
      user: userId,
      replication: replicationId,
      leia: leiaId,
      isTest,
    };
    return await SessionRepository.create(sessionData);
  }

  async finish(id) {
    const session = await SessionRepository.update(id, { finishedAt: new Date() });

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

    return session;
  }

  async saveResult(id, result) {
    return await SessionRepository.update(id, { result });
  }

  async saveResultAndFinish(id, result) {
    return await SessionRepository.update(id, { result, finishedAt: new Date() });
  }

  async saveEvaluation(id, evaluation) {
    return await SessionRepository.update(id, { evaluation });
  }

  async saveScore(id, score) {
    return await SessionRepository.update(id, { score });
  }

  async saveEvaluationAndScore(id, evaluation, score) {
    return await SessionRepository.update(id, { score, evaluation });
  }

  async addMessage(id, messageId) {
    return await SessionRepository.addMessage(id, messageId);
  }

  async updateIsRunnerInitialized(id, isRunnerInitialized) {
    return await SessionRepository.update(id, { isRunnerInitialized });
  }
}

export default new SessionService();
