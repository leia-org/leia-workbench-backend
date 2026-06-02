import ReplicationService from './ReplicationService.js';
import SessionService from './SessionService.js';
import UserService from './UserService.js';
import MessageService from './MessageService.js';
import RunnerService from './RunnerService.js';
import SpectatorService from './SpectatorService.js';
import logger from '../../utils/logger.js';
import mongoose from 'mongoose';

// Applies the problem's per-tool authoring to the tool schemas the client
// sends to the runner: drops tools the instructor disabled and appends their
// activity-specific usage guidance to each tool's description. The tool's
// schema/parameters are never authored in the problem — only referenced by
// name — so this only ever touches `description` and membership.
//
// Returns the tools unchanged when the problem declares no widgets/tools, so
// activities without tool functions are unaffected.
function applyProblemToolConfig(tools, leia) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;

  const widgets = leia?.leia?.spec?.problem?.spec?.widgets;
  if (!Array.isArray(widgets) || widgets.length === 0) return tools;

  // name -> { enabled, usage } across all of the problem's widgets.
  const config = new Map();
  for (const widget of widgets) {
    if (!Array.isArray(widget?.tools)) continue;
    for (const tool of widget.tools) {
      if (tool && typeof tool.name === 'string') config.set(tool.name, tool);
    }
  }
  if (config.size === 0) return tools;

  const out = [];
  for (const tool of tools) {
    const cfg = config.get(tool?.name);
    if (cfg && cfg.enabled === false) continue; // instructor disabled this tool
    if (cfg && typeof cfg.usage === 'string' && cfg.usage.trim()) {
      out.push({
        ...tool,
        description: `${(tool.description || '').trim()}\n\nActivity guidance: ${cfg.usage.trim()}`.trim(),
      });
    } else {
      out.push(tool);
    }
  }
  return out;
}

class InteractionService {
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
        const nextLeiaId = await ReplicationService.getAndIncrementNextLeia(replication.id);
        session = await SessionService.create(user.id, replication.id, nextLeiaId, false);
        logger.info(`Session created for user ${userEmail} and replication ${replicationCode}`);
      }
    }

    logger.info(`Session found for user ${userEmail} and replication ${replicationCode}`);
    if (!session.isRunnerInitialized) {
      logger.info(`Runner for session ${session.id} is not initialized, initializing now`);
      const leia = replication.experiment.leias.find((leia) => session.leia.equals(leia.id));
      if (!leia) {
        const error = new Error('Leia not found');
        error.statusCode = 404;
        throw error;
      }
      // Initialize runner for the session
      await RunnerService.initializeRunner(session.id, leia);

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
    }

    let session = await SessionService.create(null, replicationId, leiaId, true);

    // Initialize runner for the session
    await RunnerService.initializeRunner(session.id, leia);

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

    const leia = replication.experiment?.leias?.find((leia) => session.leia.equals(leia.id));

    if (!leia) {
      const error = new Error('Leia not found');
      error.statusCode = 404;
      throw error;
    }

    delete replication.experiment;

    if (!session.finishedAt) {
      delete leia.leia.spec.problem.spec.solution;
      delete leia.leia.spec.problem.spec.evaluationPrompt;
    }

    delete leia.leia.spec.behaviour.spec.description;
    delete leia.leia.spec.behaviour.spec.role;

    // Extract audioMode, lukeConfig and the runner provider for the
    // frontend; everything else in runnerConfiguration stays private.
    const audioMode = leia.runnerConfiguration?.audioMode || null;
    const runnerLukeConfig = leia.runnerConfiguration?.lukeConfig || null;
    const runnerProvider = leia.runnerConfiguration?.provider || null;
    const hideAudioTranscription = leia.runnerConfiguration?.hideAudioTranscription || null;

    // Widgets now live in the problem definition (authored in the designer)
    // and ride here inside leia.leia.spec.problem.spec.widgets. Fall back to
    // the legacy runnerConfiguration.lukeConfig.widgets for LEIAs configured
    // before the migration (dual-read).
    const problemWidgets = leia.leia?.spec?.problem?.spec?.widgets;
    const widgets = Array.isArray(problemWidgets) && problemWidgets.length > 0
      ? problemWidgets
      : (Array.isArray(runnerLukeConfig?.widgets) ? runnerLukeConfig.widgets : []);

    delete leia.runnerConfiguration;
    delete leia.sessionCount;

    // Decide whether the session is tool-capable. Widgets are only
    // useful when the active path supports function calls:
    //   - audioMode === 'luke': luke-server handles tools (Gemini Live
    //     and OpenAI Realtime both support function declarations).
    //   - text mode: only the `openai-responses` runner provider wires
    //     tools to the model. Other providers (gemini text, ollama)
    //     ignore them, so we don't show the widget panel for those.
    const isToolCapable =
      audioMode === 'luke' ||
      (audioMode == null && runnerProvider === 'openai-responses');

    leia.audioMode = audioMode;
    // Expose the widgets (+ luke provider/voice when present) to the FE under
    // `lukeConfig` — the shape Chat.tsx already consumes — whenever the active
    // mode can actually use them. The mode itself stays a workbench concern.
    if (audioMode === 'luke' || (isToolCapable && widgets.length > 0)) {
      leia.lukeConfig = { ...(runnerLukeConfig || {}), widgets };
    }
    leia.hideAudioTranscription = hideAudioTranscription;

    return { session, messages, leia, replication };
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

    const leia = ReplicationService.findLeia(session.replication, session.leia);
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

  async sendSessionMessage(sessionId, message, options = {}) {
    let session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    const leia = ReplicationService.findLeia(session.replication, session.leia);

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

    const { tools, toolResults } = options;
    const isToolContinuation = Array.isArray(toolResults) && toolResults.length > 0;

    // Only persist the user message on the first turn of a tool round-trip.
    // Continuations (toolResults) keep the same logical user turn going.
    if (!isToolContinuation && typeof message === 'string' && message.length > 0) {
      const newUserMessage = await MessageService.create(message, false, session.id);
      session = await SessionService.addMessage(session.id, newUserMessage.id);
    }

    // Layer the problem's per-tool authoring (disable / usage guidance) onto
    // the tool schemas the client sends. No-op when the problem declares no
    // widgets/tools, so plain text activities are unaffected.
    const effectiveTools = applyProblemToolConfig(tools, leia);
    const runnerResponse = await RunnerService.sendMessage(session.id, message, { tools: effectiveTools, toolResults });

    // Runner returns either { message } or { toolCalls } (or a raw string
    // for older code paths). Only persist a Leia message when we got a
    // final text response back.
    if (runnerResponse && Array.isArray(runnerResponse.toolCalls) && runnerResponse.toolCalls.length > 0) {
      return { toolCalls: runnerResponse.toolCalls };
    }

    const leiaMessage = typeof runnerResponse === 'string' ? runnerResponse : runnerResponse?.message;
    if (leiaMessage) {
      const newLeiaMessage = await MessageService.create(leiaMessage, true, session.id);
      session = await SessionService.addMessage(session.id, newLeiaMessage.id);
    }

    return { message: leiaMessage };
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
