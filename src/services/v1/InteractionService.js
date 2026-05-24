import ReplicationService from './ReplicationService.js';
import SessionService from './SessionService.js';
import UserService from './UserService.js';
import MessageService from './MessageService.js';
import RunnerService from './RunnerService.js';
import SpectatorService from './SpectatorService.js';
import logger from '../../utils/logger.js';
import mongoose from 'mongoose';

class InteractionService {
  getEffectiveRunnerConfiguration(replication, leia) {
    if (replication.experiment?.isMultiLeia) {
      return replication.experiment.globalConfiguration?.runner || { provider: 'default' };
    }
    return leia.runnerConfiguration || { provider: 'default' };
  }

  applyEffectiveLeiaConfiguration(replication, leia) {
    if (replication.experiment?.isMultiLeia && replication.experiment.globalConfiguration) {
      leia.configuration.askSolution = replication.experiment.globalConfiguration.askSolution;
      leia.configuration.evaluateSolution = replication.experiment.globalConfiguration.evaluateSolution;
    }
  }

  sanitizeLeiaForSession(replication, leia, sessionFinishedAt) {
    if (!sessionFinishedAt) {
      delete leia.leia.spec.problem.spec.solution;
      delete leia.leia.spec.problem.spec.evaluationPrompt;
    }

    delete leia.leia.spec.behaviour.spec.description;
    delete leia.leia.spec.behaviour.spec.role;
    this.applyEffectiveLeiaConfiguration(replication, leia);

    const audioMode = leia.runnerConfiguration?.audioMode || null;
    const lukeConfig = leia.runnerConfiguration?.lukeConfig || null;
    const hideAudioTranscription = leia.runnerConfiguration?.hideAudioTranscription || null;
    delete leia.runnerConfiguration;
    delete leia.sessionCount;

    leia.audioMode = audioMode;
    if (audioMode === 'luke' && lukeConfig) {
      leia.lukeConfig = lukeConfig;
    }
    leia.hideAudioTranscription = hideAudioTranscription;

    return leia;
  }

  async startSession(userEmail, replicationCode) {
    logger.info(`User ${userEmail} is trying to join replication ${replicationCode}`);
    const replication = await ReplicationService.findByCode(replicationCode);
    if (!replication) {
      const error = new Error('Replication not found');
      error.statusCode = 404;
      throw error;
    }
    logger.info(`Replication ${replicationCode} found`);

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

    logger.info(`User ${userEmail} found`);

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
        if (replication.experiment?.isMultiLeia) {
          session = await SessionService.createMulti(user.id, replication.id, false);
        } else {
          const nextLeiaId = await ReplicationService.getAndIncrementNextLeia(replication.id);
          session = await SessionService.create(user.id, replication.id, nextLeiaId, false);
        }
        logger.info(`Session created for user ${userEmail} and replication ${replicationCode}`);
      }
    }

    logger.info(`Session found for user ${userEmail} and replication ${replicationCode}`);
    if (!session.isRunnerInitialized) {
      logger.info(`Runner for session ${session.id} is not initialized, initializing now`);
      if (session.isMultiLEIA || replication.experiment?.isMultiLeia) {
        await RunnerService.initializeMultiRunner(
          session.id,
          replication.experiment.leias,
          this.getEffectiveRunnerConfiguration(replication, null)
        );
        session = await SessionService.updateIsRunnerInitialized(session.id, true);
        logger.info(`Multi-LEIA runner initialized for session ${session.id}`);
        return session.id;
      }

      const leia = replication.experiment.leias.find((leia) => session.leia.equals(leia.id));
      if (!leia) {
        const error = new Error('Leia not found');
        error.statusCode = 404;
        throw error;
      }
      // Initialize runner for the session
      await RunnerService.initializeRunner(session.id, leia, this.getEffectiveRunnerConfiguration(replication, leia));

      // Update the runner status
      session = await SessionService.updateIsRunnerInitialized(session.id, true);
      logger.info(`Runner initialized for session ${session.id} with Leia ${leia.id}`);
    }

    return session.id;
  }

  async startTestSession(replicationId, leiaId) {
    const replication = await ReplicationService.findById(replicationId);
    if (!replication) {
      const error = new Error('Replication not found');
      error.statusCode = 404;
      throw error;
    }
    leiaId = new mongoose.Types.ObjectId(`${leiaId}`);
    const leia = replication.experiment.leias.find((leia) => leiaId.equals(leia.id));

    if (!leia) {
      const error = new Error('Leia not found');
      error.statusCode = 404;
      throw error;
    }

    let session = await SessionService.create(null, replicationId, leiaId, true, false);

    await RunnerService.initializeRunner(session.id, leia, this.getEffectiveRunnerConfiguration(replication, leia));

    // Update the runner status
    session = await SessionService.updateIsRunnerInitialized(session.id, true);
    logger.info(`Runner initialized for session ${session.id} with Leia ${leia.id}`);

    return session.id;
  }

  async getSessionData(sessionId) {
    const session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }
    const messages = await MessageService.findBySession(session.id);
    const replication = await ReplicationService.findById(session.replication);

    if (!replication) {
      const error = new Error('Replication not found');
      error.statusCode = 404;
      throw error;
    }

    if (session.isMultiLEIA || replication.experiment?.isMultiLeia) {
      const leias = replication.experiment.leias.map((leia) =>
        this.sanitizeLeiaForSession(replication, leia, session.finishedAt)
      );
      const leia = leias[0];

      delete replication.experiment;

      return { session, messages, leia, leias, replication };
    }

    const leia = replication.experiment?.leias?.find((leia) => session.leia.equals(leia.id));

    if (!leia) {
      const error = new Error('Leia not found');
      error.statusCode = 404;
      throw error;
    }

    delete replication.experiment;

    return { session, messages, leia: this.sanitizeLeiaForSession(replication, leia, session.finishedAt), replication };
  }

  async getSolutionAndFormat(sessionId) {
    const session = await SessionService.findById(sessionId);
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

    if (!session.result) {
      const error = new Error('Session has no result yet');
      error.statusCode = 403;
      throw error;
    }

    let leia = null;
    const replication = await ReplicationService.findById(session.replication);
    if (session.isMultiLEIA || replication?.experiment?.isMultiLeia) {
      leia = replication?.experiment?.leias?.[0] || null;
    } else {
      leia = await ReplicationService.findLeia(session.replication, session.leia);
    }
    if (!leia) {
      const error = new Error('Leia not found');
      error.statusCode = 404;
      throw error;
    }

    const solution = leia.leia?.spec?.problem?.spec?.solution;
    const solutionFormat = leia.leia?.spec?.problem?.spec?.solutionFormat;

    if (!solution) {
      const error = new Error('Solution not found');
      error.statusCode = 404;
      throw error;
    }

    return { solution, solutionFormat };
  }

  async sendSessionMessage(sessionId, message) {
    let session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    const replication = await ReplicationService.findById(session.replication);
    const isMultiSession = session.isMultiLEIA || replication?.experiment?.isMultiLeia;

    if (!isMultiSession) {
      const leia = await ReplicationService.findLeia(session.replication, session.leia);

      if (!leia) {
        const error = new Error('Leia not found');
        error.statusCode = 404;
        throw error;
      }

      if (leia.configuration?.mode == 'transcription') {
        const error = new Error('Cannot send messages in transcription mode');
        error.statusCode = 403;
        throw error;
      }
    } else {
      if (replication?.experiment?.globalConfiguration?.mode === 'transcription') {
        const error = new Error('Cannot send messages in transcription mode');
        error.statusCode = 403;
        throw error;
      }
    }

    const newUserMessage = await MessageService.create(message, false, session.id);
    session = await SessionService.addMessage(session.id, newUserMessage.id);

    const leiaResponse = await RunnerService.sendMessage(session.id, message);
    const leiaMessage = typeof leiaResponse === 'string' ? leiaResponse : leiaResponse.message;
    const leiaId = typeof leiaResponse === 'object' ? leiaResponse.leiaId : null;

    if (!leiaMessage) {
      const error = new Error('Runner returned an empty LEIA message');
      error.statusCode = 500;
      throw error;
    }

    const newLeiaMessage = await MessageService.create(leiaMessage, true, session.id, leiaId);
    session = await SessionService.addMessage(session.id, newLeiaMessage.id);

    return { message: leiaMessage, leiaId };
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

    // Generate spectator link with 1 year expiration
    const oneYearInSeconds = 365 * 24 * 60 * 60; // 31,536,000 seconds
    const spectatorData = await SpectatorService.generateSpectateToken(session.id, oneYearInSeconds);
    const spectateUrl = SpectatorService.generateSpectateUrl(session.id, spectatorData.token);

    return {
      ...session.toObject(),
      spectateUrl,
      spectateToken: spectatorData.token,
      spectateExpiresAt: spectatorData.expiresAt,
    };
  }

  async finishSession(sessionId) {
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
    session = await SessionService.finish(session.id);
    await RunnerService.deleteCache(session.id);
    logger.info(`Cache deleted for session ${session.id}`);

    // Generate spectator link with 1 year expiration
    const oneYearInSeconds = 365 * 24 * 60 * 60; // 31,536,000 seconds
    const spectatorData = await SpectatorService.generateSpectateToken(session.id, oneYearInSeconds);
    const spectateUrl = SpectatorService.generateSpectateUrl(session.id, spectatorData.token);

    return {
      ...session.toObject(),
      spectateUrl,
      spectateToken: spectatorData.token,
      spectateExpiresAt: spectatorData.expiresAt,
    };
  }

  async saveDraft(sessionId, draft) {
    const session = await SessionService.findById(sessionId);
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
    return await SessionService.saveDraft(session.id, draft);
  }

  async getEvaluation(sessionId) {
    let session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    if (!session.evaluation || !session.score) {
      if (!session.finishedAt) {
        const error = new Error('Session is not finished yet');
        error.statusCode = 403;
        throw error;
      }

      if (!session.result) {
        const error = new Error('Session has no result yet');
        error.statusCode = 403;
        throw error;
      }

      logger.info('Session has no evaluation yet, trying to get it from the runner');
      const res = await RunnerService.getEvaluationAndScore(session.id, session.result);
      session = await SessionService.saveEvaluationAndScore(session.id, res.evaluation, res.score);
      logger.info('Session evaluation saved');
    }
    return { evaluation: session.evaluation, score: session.score };
  }
}

export default new InteractionService();
