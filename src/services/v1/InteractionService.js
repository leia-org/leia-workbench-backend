import ReplicationService from './ReplicationService.js';
import SessionService from './SessionService.js';
import UserService from './UserService.js';
import MessageService from './MessageService.js';
import RunnerService from './RunnerService.js';
import SpectatorService from './SpectatorService.js';
import SupervisorService from './SupervisorService.js';
import logger from '../../utils/logger.js';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';

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
        await RunnerService.initializeRunner(session.id, leia);
      }

      // Update the runner status
      session = await SessionService.updateIsRunnerInitialized(session.id, true);
      logger.info(`Runner initialized for session ${session.id} with Leia ${leia.id}`);
    }

    return session.id;
  }

  async startTestSession(replicationId, leiaId, multiLeia = false) {
    const replication = await ReplicationService.findById(replicationId);
    if (!replication) {
      const error = new Error('Replication not found');
      error.statusCode = 404;
      throw error;
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

    const multiLeia = buildMultiLeiaPayload(replication, session);

    delete replication.experiment;

    if (!session.finishedAt) {
      delete leia.leia.spec.problem.spec.solution;
      delete leia.leia.spec.problem.spec.evaluationPrompt;
    }

    delete leia.leia.spec.behaviour.spec.description;

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
    
    const sessionUser = session.user ? await UserService.findById(session.user) : null;
    const sessionData = stripSupervisorFields(session);
    sessionData.userEmail = sessionUser?.email || null;
    if (leia.leia?.spec) delete leia.leia.spec.supervisorConfig;

    return {
      session: sessionData,
      messages,
      leia,
      replication,
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

    if (session.finishedAt) {
      const error = new Error('Session already finished');
      error.statusCode = 403;
      throw error;
    }

    session = await SessionService.saveResultAndFinish(session.id, result);

    // Final supervisor pass (covers the onFinish cadence and the last turns).
    const finishedLeia = await ReplicationService.findLeia(session.replication, session.leia);
    if (finishedLeia) SupervisorService.observeAsync(session.id, finishedLeia, { force: true });

    // Generate spectator link with 1 year expiration
    const oneYearInSeconds = 365 * 24 * 60 * 60; // 31,536,000 seconds
    const spectatorData = await SpectatorService.generateSpectateToken(session.id, oneYearInSeconds);
    const spectateUrl = SpectatorService.generateSpectateUrl(session.id, spectatorData.token);

    return {
      ...stripSupervisorFields(session),
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

    // Final supervisor pass (covers the onFinish cadence and the last turns).
    const finishedLeia = await ReplicationService.findLeia(session.replication, session.leia);
    if (finishedLeia) SupervisorService.observeAsync(session.id, finishedLeia, { force: true });

    await RunnerService.deleteCache(session.id);
    logger.info(`Cache deleted for session ${session.id}`);

    // Generate spectator link with 1 year expiration
    const oneYearInSeconds = 365 * 24 * 60 * 60; // 31,536,000 seconds
    const spectatorData = await SpectatorService.generateSpectateToken(session.id, oneYearInSeconds);
    const spectateUrl = SpectatorService.generateSpectateUrl(session.id, spectatorData.token);

    return {
      ...stripSupervisorFields(session),
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
