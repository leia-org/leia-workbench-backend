import ConversationDynamicsService, { publicDynamicsState } from './ConversationDynamicsService.js';
import ReplicationService from './ReplicationService.js';
import SessionService from './SessionService.js';
import UserService from './UserService.js';
import MessageService from './MessageService.js';
import RunnerService from './RunnerService.js';
import SpectatorService from './SpectatorService.js';
import SupervisorService from './SupervisorService.js';
import logger from '../../utils/logger.js';
import mongoose from 'mongoose';
import { randomInt, randomUUID } from 'crypto';
import SessionRepository from '../../repositories/v1/SessionRepository.js';
import { resolveStageLeias } from './ActivityStageService.js';
import { activityError, activityFlows, stageExperiment, stageProgress } from '../../utils/activityStages.js';

const stageInitializations = new Map();

// Applies the problem's per-tool authoring to the tool schemas the client
// sends to the runner: drops tools the instructor disabled and appends their
// activity-specific usage guidance to each tool's description. The tool's
// schema/parameters are never authored in the problem — only referenced by
// name — so this only ever touches `description` and membership.
//
// Returns the tools unchanged when the problem declares no widgets/tools, so
// activities without tool functions are unaffected.
// Strip instructor-only supervisor data from a session before it is returned
// to the student (any student-facing endpoint that serialises a Session).
function stripSupervisorFields(session) {
  const data = session && typeof session.toObject === 'function' ? session.toObject({ virtuals: true }) : { ...session };
  delete data._id;
  delete data.__v;
  delete data.supervisorFlags;
  delete data.supervisorState;
  delete data.conversationDynamicsState;
  delete data.previousStageSession;
  delete data.sourceStageId;
  delete data.stageRunKey;
  return data;
}

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

function buildLeiaInfographicFallbackPaths(leiaId) {
  const id = leiaId ? `${leiaId}`.trim() : '';
  if (!id) return [];
  return ['png', 'jpg'].map((extension) => `/images/leias/${id}/infographic/original.${extension}`);
}

function isMultiLeiaEnabled(replication) {
  return Boolean(
    replication?.experiment?.orchestration?.mode === 'multi' &&
      Array.isArray(replication?.experiment?.leias) &&
      replication.experiment.leias.length >= 2
  );
}

function getMultiLeiaEntries(replication, session = null) {
  const selectedIds = Array.isArray(session?.leias)
    ? new Set(session.leias.map((id) => String(id)))
    : null;
  const entries = replication?.experiment?.leias || [];
  return selectedIds
    ? entries.filter((entry) => selectedIds.has(String(entry.id)))
    : entries;
}

function getOpeningLeia(replication) {
  const entries = replication?.experiment?.leias || [];
  const openingLeiaId = replication?.experiment?.orchestration?.openingLeiaId;
  return (
    entries.find((entry) => String(entry.id) === String(openingLeiaId)) ||
    entries[0] ||
    null
  );
}

function getProblemLeia(replication) {
  const entries = replication?.experiment?.leias || [];
  const problemLeiaId = replication?.experiment?.orchestration?.problemLeiaId;
  return (
    entries.find((entry) => String(entry.id) === String(problemLeiaId)) ||
    getOpeningLeia(replication)
  );
}

function chooseStageLeia(entries) {
  const fewestSessions = Math.min(...entries.map((entry) => entry.sessionCount ?? 0));
  const candidates = entries.filter((entry) => (entry.sessionCount ?? 0) === fewestSessions);
  return candidates[randomInt(candidates.length)];
}

function buildMultiLeiaPayload(replication, session) {
  if (session?.interactionMode !== 'multi') return null;
  const orchestration = replication?.experiment?.orchestration || {};
  const actors = getMultiLeiaEntries(replication, session).map((entry, index) => {
    const leia = entry.leia || {};
    const persona = leia.spec?.persona || {};
    const personaSpec = persona.spec || {};
    return {
      id: String(entry.id),
      name:
        personaSpec.firstName ||
        personaSpec.fullName ||
        leia.metadata?.name ||
        `LEIA ${index + 1}`,
      avatar: personaSpec.avatar || leia.spec?.avatar || null,
      leiaId: leia.id ? String(leia.id) : null,
      personaId: persona.id ? String(persona.id) : null,
    };
  });
  return {
    enabled: true,
    actors,
    orchestration: {
      maxInternalTurns: orchestration.maxInternalTurns || 2,
      openingLeiaId: orchestration.openingLeiaId
        ? String(orchestration.openingLeiaId)
        : actors[0]?.id || null,
      problemLeiaId: orchestration.problemLeiaId
        ? String(orchestration.problemLeiaId)
        : actors[0]?.id || null,
    },
    state: session.multiLeiaState || null,
  };
}

class InteractionService {
  async openStage(replication, stage, { userId, previous, isTest = false, stageRunKey }) {
    const flow = stageExperiment(replication.experiment, stage);
    const scope = { experiment: flow };
    const multi = isMultiLeiaEnabled(scope);
    const leia = multi ? getProblemLeia(scope) : chooseStageLeia(flow.leias);
    const { session, created } = await SessionRepository.createStageOnce({
      user: userId,
      replication: replication.id,
      leia: leia.id,
      isTest,
      interactionMode: multi ? 'multi' : 'single',
      ...(multi ? { leias: flow.leias.map((entry) => entry.id) } : {}),
      stageId: stage.id,
      sourceStageId: stage.previousStageId,
      previousStageSession: previous?.id,
      stageRunKey,
    });
    if (created && !multi && !isTest) {
      await ReplicationService.recordStageAssignment(replication.id, leia.id);
    }
    return await this.openStageRunner(replication, session);
  }

  async openStageRunner(replication, session) {
    if (session.finishedAt) return session.id;
    const existing = stageInitializations.get(session.id);
    if (existing) return await existing;
    const opening = this.initializeStageRunner(replication, session);
    stageInitializations.set(session.id, opening);
    try {
      return await opening;
    } finally {
      stageInitializations.delete(session.id);
    }
  }

  async initializeStageRunner(replication, session) {
    const stage = replication.experiment.stages.find(({ id }) => id === session.stageId);
    if (!stage) throw activityError('Stage not found', 404);
    const flow = stageExperiment(replication.experiment, stage);
    const leia = flow.leias.find((entry) => String(entry.id) === String(session.leia));
    if (!leia) throw activityError('LEIA not found', 404);
    const multi = session.interactionMode === 'multi';
    if (!session.isRunnerInitialized) {
      const entries = multi ? getMultiLeiaEntries({ experiment: flow }, session) : [leia];
      if (entries.some(({ runnerConfiguration: config }) =>
        !config?.modelName || !config?.apiKeyId || !config?.apiKeyRequesterId ||
        (multi && config.audioMode))) {
        throw activityError('Configure a valid model and API key for each LEIA before starting this stage');
      }
      const resolved = await resolveStageLeias(session, entries);
      if (multi) {
        let state;
        try {
          ({ state } = await RunnerService.initializeMultiLeia(session.id, resolved, flow.orchestration));
        } catch (error) {
          if (error.response?.status !== 409) throw error;
          state = await RunnerService.getMultiLeiaState(session.id);
        }
        await SessionService.updateMultiLeiaState(session.id, state);
      } else {
        try {
          await RunnerService.initializeRunner(session.id, resolved[0], replication.language);
        } catch (error) {
          if (error.response?.status !== 409 || error.response.data?.sessionId !== session.id) throw error;
        }
      }
      await SessionService.updateIsRunnerInitialized(session.id, true);
    }
    if (!multi) await ConversationDynamicsService.openText(session.id, leia);
    return session.id;
  }

  async startStagedActivity(replication, userId) {
    activityFlows(replication.experiment);
    const last = await SessionRepository.findLatestStageSession(userId, replication.id);
    if (last && !last.finishedAt) return await this.openStageRunner(replication, last);
    if (last && stageProgress(replication.experiment, last)?.hasNext) {
      return await this.continueStage(last.id);
    }
    if (last && !replication.isRepeatable) {
      throw activityError('User has already finished this replication. Replication is not repeatable.', 403);
    }
    return await this.openStage(replication, replication.experiment.stages[0], {
      userId,
      stageRunKey: `initial:${replication.id}:${userId}:${last?.id ?? ''}`,
    });
  }

  async continueStage(sessionId) {
    const previous = await SessionService.findById(sessionId);
    if (!previous?.stageId) throw activityError('Stage session not found', 404);
    if (!previous.finishedAt) throw activityError('Finish the current stage before continuing', 409);
    const replication = await ReplicationService.findById(previous.replication);
    if (!replication) throw activityError('Replication not found', 404);
    if (!previous.isTest && !replication.isActive) throw activityError('Replication is not active', 403);
    const progress = stageProgress(replication.experiment, previous);
    if (!progress?.hasNext) throw activityError('This is the final stage', 409);
    return await this.openStage(replication, replication.experiment.stages[progress.number], {
      userId: previous.user,
      previous,
      isTest: previous.isTest,
      stageRunKey: `next:${previous.id}`,
    });
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
      try {
        user = await UserService.create({ email: userEmail });
      } catch (error) {
        if (error.code !== 11000 || !error.keyPattern?.email) throw error;
        user = await UserService.findByEmail(userEmail);
        if (!user) throw error;
      }
    }

    logger.info(`User ${userEmail} found`);
    if (replication.experiment.stages) return await this.startStagedActivity(replication, user.id);

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
        if (isMultiLeiaEnabled(replication)) {
          const entries = getMultiLeiaEntries(replication);
          const problemLeia = getProblemLeia(replication);
          session = await SessionService.create(user.id, replication.id, problemLeia.id, false, {
            interactionMode: 'multi',
            leias: entries.map((entry) => entry.id),
          });
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
      const leia = replication.experiment.leias.find((leia) => session.leia.equals(leia.id));
      if (!leia) {
        const error = new Error('Leia not found');
        error.statusCode = 404;
        throw error;
      }
      if (session.interactionMode === 'multi') {
        const entries = getMultiLeiaEntries(replication, session);
        const result = await RunnerService.initializeMultiLeia(
          session.id,
          entries,
          replication.experiment.orchestration
        );
        session = await SessionService.updateMultiLeiaState(session.id, result.state);
      } else {
        await RunnerService.initializeRunner(session.id, leia, replication.language);
      }

      // Update the runner status
      session = await SessionService.updateIsRunnerInitialized(session.id, true);
      logger.info(`Runner initialized for session ${session.id} with Leia ${leia.id}`);
    }

    if (session.interactionMode !== 'multi') {
      const activeLeia = replication.experiment.leias.find((entry) => session.leia.equals(entry.id));
      await ConversationDynamicsService.openText(session.id, activeLeia);
    }
    return session.id;
  }

  async startTestSession(replicationId, leiaId, multiLeia = false, staged = false) {
    const replication = await ReplicationService.findById(replicationId);
    if (!replication) {
      const error = new Error('Replication not found');
      error.statusCode = 404;
      throw error;
    }
    if (staged || replication.experiment.stages) {
      if (!replication.experiment.stages) throw activityError('This activity has no stages');
      activityFlows(replication.experiment);
      return await this.openStage(replication, replication.experiment.stages[0], {
        isTest: true,
        stageRunKey: `test:${randomUUID()}`,
      });
    }
    if (multiLeia) {
      if (!isMultiLeiaEnabled(replication)) {
        const error = new Error('MultiLEIA is not enabled for this replication');
        error.statusCode = 400;
        throw error;
      }
      const entries = getMultiLeiaEntries(replication);
      const invalidEntry = entries.find(
        (entry) =>
          !entry.runnerConfiguration?.modelName ||
          !entry.runnerConfiguration?.apiKeyId ||
          !entry.runnerConfiguration?.apiKeyRequesterId ||
          entry.runnerConfiguration?.audioMode
      );
      if (invalidEntry) {
        const error = new Error('All MultiLEIA actors require a valid text runner configuration');
        error.statusCode = 400;
        throw error;
      }
      const problemLeia = getProblemLeia(replication);
      let session = await SessionService.create(null, replicationId, problemLeia.id, true, {
        interactionMode: 'multi',
        leias: entries.map((entry) => entry.id),
      });
      const result = await RunnerService.initializeMultiLeia(
        session.id,
        entries,
        replication.experiment.orchestration
      );
      session = await SessionService.updateMultiLeiaState(session.id, result.state);
      session = await SessionService.updateIsRunnerInitialized(session.id, true);
      logger.info(`MultiLEIA runner initialized for test session ${session.id}`);
      return session.id;
    }

    leiaId = new mongoose.Types.ObjectId(`${leiaId}`);
    const leia = replication.experiment.leias.find((leia) => leiaId.equals(leia.id));

    if (!leia) {
      const error = new Error('Leia not found');
      error.statusCode = 404;
      throw error;
    }
    if (!leia.runnerConfiguration?.modelName || !leia.runnerConfiguration?.apiKeyId || !leia.runnerConfiguration?.apiKeyRequesterId) {
      const error = new Error('Invalid runner configuration');
      error.statusCode = 400;
      throw error;
    }

    let session = await SessionService.create(null, replicationId, leiaId, true);

    // Initialize runner for the session
    await RunnerService.initializeRunner(session.id, leia, replication.language);


    // Update the runner status
    session = await SessionService.updateIsRunnerInitialized(session.id, true);
    logger.info(`Runner initialized for session ${session.id} with Leia ${leia.id}`);
    await ConversationDynamicsService.openText(session.id, leia);

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

    const experiment = replication.experiment;
    const stage = experiment.stages?.find(({ id }) => id === session.stageId);
    const multiLeia = buildMultiLeiaPayload(stage
      ? { experiment: stageExperiment(experiment, stage) }
      : replication, session);
    const progress = stageProgress(experiment, session);

    const replicationData = typeof replication.toJSON === 'function' ? replication.toJSON() : { ...replication };
    delete replicationData.experiment;

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
    const infographicConfig = leia.runnerConfiguration?.infographic || {};
    const infographicSrc = leia.leia?.spec?.infographic || null;
    const infographicFallbackSources = buildLeiaInfographicFallbackPaths(leia.leia?.id || leia.leia?._id || leia.id);
    const infographicFallbackSrc = infographicFallbackSources[0] || null;
    if (leia.leia?.spec) {
      delete leia.leia.spec.infographic;
      delete leia.leia.spec.infographicSolution;
    }

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
    if (infographicConfig.showToStudent && (infographicSrc || infographicFallbackSrc)) {
      leia.infographic = {
        src: infographicSrc || infographicFallbackSrc,
        fallbackSrc: infographicFallbackSrc,
        fallbackSources: infographicFallbackSources,
      };
    }
    // Expose the widgets (+ luke provider/voice when present) to the FE under
    // `lukeConfig` — the shape Chat.tsx already consumes — whenever the active
    // mode can actually use them. The mode itself stays a workbench concern.
    if (audioMode === 'luke' || (isToolCapable && widgets.length > 0)) {
      leia.lukeConfig = { ...(runnerLukeConfig || {}), widgets };
    }
    leia.hideAudioTranscription = hideAudioTranscription;

    // Supervisor data is instructor-only: strip it (and the supervisor config)
    // from the payload the student receives.
    const sessionData = stripSupervisorFields(session);
    if (progress) sessionData.stage = progress;
    sessionData.conversationDynamics = publicDynamicsState(session, leia);
    delete leia.leia.spec.behaviour.spec.conversationDynamics;
    if (leia.leia?.spec) delete leia.leia.spec.supervisorConfig;

    return {
      session: sessionData,
      messages,
      leia,
      replication: replicationData,
      ...(multiLeia ? { multiLeia } : {}),
    };
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

    const leia = await ReplicationService.findLeia(session.replication, session.leia);
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

  async streamSessionMessage(sessionId, message, options = {}) {
    let session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }
    if (session.interactionMode !== 'multi') {
      const error = new Error('Streaming group chat is only available for MultiLEIA sessions');
      error.statusCode = 400;
      throw error;
    }

    const leia = await ReplicationService.findLeia(session.replication, session.leia);
    if (!leia) {
      const error = new Error('Leia not found');
      error.statusCode = 404;
      throw error;
    }
    if (leia.configuration?.mode === 'transcription') {
      const error = new Error('Cannot send messages in transcription mode');
      error.statusCode = 403;
      throw error;
    }
    if (typeof message !== 'string' || !message.trim()) {
      const error = new Error('Message is required');
      error.statusCode = 400;
      throw error;
    }

    const turnId = randomUUID();
    const participantSequence = Number(session.multiLeiaState?.lastSequence || 0) + 1;
    let participantPersisted = false;
    const createdMessages = [];

    const persistParticipant = async () => {
      if (participantPersisted) return;
      const participantMessage = await MessageService.create(message, false, session.id, {
        senderType: 'participant',
        senderId: 'participant',
        senderName: 'Participant',
        recipientIds: (session.leias || []).map((id) => String(id)),
        sequence: participantSequence,
        turnId,
      });
      session = await SessionService.addMessage(session.id, participantMessage.id);
      participantPersisted = true;
    };

    const runnerResult = await RunnerService.streamMultiLeiaMessage(
      session.id,
      message,
      turnId,
      {
        onRoute: async (route) => options.onRoute?.(route),
        onMessage: async (event) => {
          await persistParticipant();
          const createdMessage = await MessageService.create(event.text, true, session.id, {
            senderType: 'agent',
            senderId: event.senderId,
            senderName: event.senderName,
            recipientIds: event.recipientIds,
            addressedToId: event.addressedToId,
            addressedToName: event.addressedToName,
            sequence: event.sequence,
            turnId,
            timestamp: event.timestamp,
          });
          session = await SessionService.addMessage(session.id, createdMessage.id);
          createdMessages.push(createdMessage);
          await options.onMessage?.(createdMessage);
        },
      }
    );

    if (runnerResult.state) {
      session = await SessionService.updateMultiLeiaState(session.id, runnerResult.state);
    }
    if (createdMessages.length > 0) {
      SupervisorService.observeAsync(session.id, leia);
    }

    const pendingNudge = session.supervisorState?.pendingNudge || null;
    if (pendingNudge) {
      await SessionService.clearPendingNudge(session.id, pendingNudge);
    }
    return {
      turnId,
      state: runnerResult.state,
      partial: Boolean(runnerResult.partial),
      ...(pendingNudge ? { nudge: pendingNudge } : {}),
    };
  }

  async sendSessionMessage(sessionId, message, options = {}) {
    let session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    const leia = await ReplicationService.findLeia(session.replication, session.leia);

    if (!leia) {
      const error = new Error('Leia not found');
      error.statusCode = 404;
      throw error;
    }

    const dynamicsState = publicDynamicsState(session, leia);
    if (dynamicsState.leiaSpeaksFirst.enabled && !dynamicsState.leiaSpeaksFirst.completed) {
      const error = new Error('Wait for LEIA to start the conversation');
      error.statusCode = 409;
      throw error;
    }

    if (leia.configuration?.mode == 'transcription') {
      const error = new Error('Cannot send messages in transcription mode');
      error.statusCode = 403;
      throw error;
    }

    if (session.interactionMode === 'multi') {
      if (Array.isArray(options.toolResults) && options.toolResults.length > 0) {
        const error = new Error('Tool continuations are not supported in MultiLEIA text mode');
        error.statusCode = 400;
        throw error;
      }
      if (typeof message !== 'string' || !message.trim()) {
        const error = new Error('Message is required');
        error.statusCode = 400;
        throw error;
      }

      const turnId = randomUUID();
      const participantSequence = Number(session.multiLeiaState?.lastSequence || 0) + 1;
      const runnerResult = await RunnerService.sendMultiLeiaMessage(
        session.id,
        message,
        turnId
      );
      const participantMessage = await MessageService.create(message, false, session.id, {
        senderType: 'participant',
        senderId: 'participant',
        senderName: 'Participant',
        recipientIds: (session.leias || []).map((id) => String(id)),
        sequence: participantSequence,
        turnId,
      });
      session = await SessionService.addMessage(session.id, participantMessage.id);
      const createdMessages = [];
      for (const event of runnerResult.messages || []) {
        const createdMessage = await MessageService.create(event.text, true, session.id, {
          senderType: 'agent',
          senderId: event.senderId,
          senderName: event.senderName,
          recipientIds: event.recipientIds,
          addressedToId: event.addressedToId,
          addressedToName: event.addressedToName,
          sequence: event.sequence,
          turnId,
          timestamp: event.timestamp,
        });
        session = await SessionService.addMessage(session.id, createdMessage.id);
        createdMessages.push(createdMessage);
      }
      if (runnerResult.state) {
        session = await SessionService.updateMultiLeiaState(session.id, runnerResult.state);
      }
      if (createdMessages.length > 0) {
        SupervisorService.observeAsync(session.id, leia);
      }

      const pendingNudge = session.supervisorState?.pendingNudge || null;
      if (pendingNudge) {
        await SessionService.clearPendingNudge(session.id, pendingNudge);
      }
      return {
        messages: createdMessages,
        state: runnerResult.state,
        partial: Boolean(runnerResult.partial),
        ...(pendingNudge ? { nudge: pendingNudge } : {}),
      };
    }

    // A nudge queued by the supervisor on a PREVIOUS turn is delivered on this
    // turn's response (the student has no socket; this is the reliable channel).
    const pendingNudge = session.supervisorState?.pendingNudge || null;

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
      // A tool round-trip is still the same logical turn; deliver any pending
      // nudge here too so it isn't dropped for tool-using activities.
      if (pendingNudge) {
        await SessionService.clearPendingNudge(session.id, pendingNudge);
        return { toolCalls: runnerResponse.toolCalls, nudge: pendingNudge };
      }
      return { toolCalls: runnerResponse.toolCalls };
    }

    const leiaMessage = typeof runnerResponse === 'string' ? runnerResponse : runnerResponse?.message;
    if (leiaMessage) {
      const newLeiaMessage = await MessageService.create(leiaMessage, true, session.id);
      session = await SessionService.addMessage(session.id, newLeiaMessage.id);

      // A full exchange completed: let the background supervisor observe it
      // (fire-and-forget; respects cadence and is a no-op when disabled).
      SupervisorService.observeAsync(session.id, leia);
      await ConversationDynamicsService.observeSafely(session.id, leia);
    }

    // Deliver (and clear) any nudge the supervisor queued previously. The clear
    // is conditional on the delivered value so a nudge written by this turn's
    // in-flight observation isn't clobbered.
    if (pendingNudge) {
      await SessionService.clearPendingNudge(session.id, pendingNudge);
      return { message: leiaMessage, nudge: pendingNudge };
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

    if (session.finishedAt && session.result !== result) {
      const error = new Error('Session already finished');
      error.statusCode = 403;
      throw error;
    }

    if (!session.finishedAt) {
      const dynamicsLeia = await ReplicationService.findLeia(session.replication, session.leia);
      await ConversationDynamicsService.assertCanFinish(session, dynamicsLeia);
      session = session.stageId
        ? await SessionService.finishStage(session.id, result)
        : await SessionService.saveResultAndFinish(session.id, result);
      if (dynamicsLeia) SupervisorService.observeAsync(session.id, dynamicsLeia, { force: true });
    }

    return await this.finishedSessionData(session);
  }

  async finishedSessionData(session) {
    const data = stripSupervisorFields(session);
    if (session.stageId) {
      const replication = await ReplicationService.findById(session.replication);
      if (replication) data.stage = stageProgress(replication.experiment, session);
    }
    // Generate spectator link with 1 year expiration
    const oneYearInSeconds = 365 * 24 * 60 * 60; // 31,536,000 seconds
    const spectatorData = await SpectatorService.generateSpectateToken(session.id, oneYearInSeconds);
    const spectateUrl = SpectatorService.generateSpectateUrl(session.id, spectatorData.token);

    return {
      ...data,
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
      if (session.stageId) return await this.finishedSessionData(session);
      const error = new Error('Session already finished');
      error.statusCode = 403;
      throw error;
    }
    const dynamicsLeia = await ReplicationService.findLeia(session.replication, session.leia);
    await ConversationDynamicsService.assertCanFinish(session, dynamicsLeia);
    session = session.stageId
      ? await SessionService.finishStage(session.id)
      : await SessionService.finish(session.id);

    // Final supervisor pass (covers the onFinish cadence and the last turns).
    const finishedLeia = await ReplicationService.findLeia(session.replication, session.leia);
    if (finishedLeia) SupervisorService.observeAsync(session.id, finishedLeia, { force: true });

    await RunnerService.deleteCache(session.id);
    logger.info(`Cache deleted for session ${session.id}`);

    return await this.finishedSessionData(session);
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
    const updated = await SessionService.saveDraft(session.id, draft);
    return stripSupervisorFields(updated);
  }

  async getEvaluation(sessionId) {
    let session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    if (!session.evaluation || session.score == null) {
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
