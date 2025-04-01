import ReplicationService from './ReplicationService.js';
import SessionService from './SessionService.js';
import UserService from './UserService.js';
import MessageService from './MessageService.js';
import RunnerService from './RunnerService.js';
import logger from '../../utils/logger.js';

class InteractionService {
  async startSession(userEmail, replicationCode) {
    logger.info(`User ${userEmail} is trying to join replication ${replicationCode}`);
    const replication = await ReplicationService.findByCode(replicationCode);
    if (!replication) {
      const error = new Error('Replication not found');
      error.statusCode = 404;
      throw error;
    }
    logger.info(`Replication ${replicationCode} found for user ${userEmail}`);

    if (!replication.isActive) {
      const error = new Error('Replication is not active');
      error.statusCode = 403;
      throw error;
    }

    let user = await UserService.findByEmail(userEmail);
    if (!user) {
      logger.info(`User ${userEmail} not found, creating new user`);
      user = await UserService.create({ email: userEmail });
    }

    logger.info(`User ${userEmail} found or created`);

    let session = await SessionService.findOneUnfinishedByUserAndReplication(user.id, replication.id);

    if (!session) {
      logger.info(
        `Session not found for user ${userEmail} and replication ${replicationCode} checking possibility of creating a new one`
      );
      const hasAnyFinished = await SessionService.hasAnyFinished(user.id, replication.id);
      if (hasAnyFinished && !replication.isRepeatable) {
        const error = new Error('User has already finished this replication. Replication is not repeatable.');
        error.statusCode = 403;
        throw error;
      } else {
        logger.info(`Creating new session for user ${userEmail} and replication ${replicationCode}`);
        const nextLeiaId = await ReplicationService.getAndIncrementNextLeia(replication.id);

        session = await SessionService.create({
          user: user.id,
          replication: replication.id,
          leia: nextLeiaId,
          isTest: false,
        });
        logger.info(`Session created for user ${userEmail} and replication ${replicationCode}`);
      }
    }

    if (!session.isRunnerInitialized) {
      logger.info(`Runner for session ${session.id} is not initialized, initializing now`);
      const leia = replication.experiment.leias.find((leia) => leia.id === session.leia);

      // Initialize runner for the session
      await RunnerService.initializeRunner(session.id, leia);

      // Update the runner status
      session = await SessionService.updateIsRunnerInitialized(session.id, true);
      logger.info(`Runner initialized for session ${session.id} with Leia ${leia.id}`);
    }

    return { sessionId: session.id };
  }

  async startTestSession(replicationId, leiaId) {
    const replication = await ReplicationService.findById(replicationId);
    if (!replication) {
      const error = new Error('Replication not found');
      error.statusCode = 404;
      throw error;
    }

    const leia = replication.experiment.leias.find((leia) => leia.id === leiaId);

    if (!leia) {
      const error = new Error('Leia not found');
      error.statusCode = 404;
    }

    let session = await SessionService.create({
      user: null,
      replication: replication.id,
      leia: leiaId,
      isTest: true,
    });

    // Initialize runner for the session
    await RunnerService.initializeRunner(session.id, leia);

    // Update the runner status
    session = await SessionService.updateIsRunnerInitialized(session.id, true);
    logger.info(`Runner initialized for session ${session.id} with Leia ${leia.id}`);

    return { sessionId: session.id };
  }

  async getSessionData(sessionId) {
    const session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }
    const messages = await MessageService.findBySession(session.id);
    const leia = await ReplicationService.findLeia(session.replication, session.leia);

    if (!session.finishedAt) {
      delete leia.leia.spec.problem.spec.solution;
    }

    delete leia.leia.spec.behaviour;
    delete leia.runnerConfiguration;
    delete leia.sessionCount;

    return { session, messages, leia };
  }

  async sendSessionMessage(sessionId, message) {
    let session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    const newUserMessage = await MessageService.create(message, false, session.id);
    session = await SessionService.addMessage(session.id, newUserMessage.id);

    const leiaMessage = await RunnerService.sendMessage(session.id, message);

    const newLeiaMessage = await MessageService.create(leiaMessage, true, session.id);
    session = await SessionService.addMessage(session.id, newLeiaMessage.id);

    return leiaMessage;
  }

  async saveResultAndFinishSession(sessionId, result) {
    let session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    if (session.finishedAt) {
      const error = new Error('Session already finished');
      error.statusCode = 403;
      throw error;
    }

    session = await SessionService.saveResultAndFinish(session.id, result);
    return session;
  }

  async getEvaluation(sessionId) {
    let session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    if (!session.finishedAt) {
      const error = new Error('Session is not finished yet');
      error.statusCode = 403;
      throw error;
    }

    if (!session.evaluation) {
      logger.info('Session has no evaluation yet, trying to get it from the runner');
      const leia = await ReplicationService.findLeia(session.replication, session.leia);
      const evaluation = await RunnerService.getEvaluation(session.id, leia);
      session = await SessionService.saveEvaluation(session.id, evaluation);
      logger.info('Session evaluation saved');
    }
    return session.evaluation;
  }
}

export default new InteractionService();
