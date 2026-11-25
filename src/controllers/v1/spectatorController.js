import SpectatorService from '../../services/v1/SpectatorService.js';
import SessionRepository from '../../repositories/v1/SessionRepository.js';
import SessionService from '../../services/v1/SessionService.js';
import ReplicationService from '../../services/v1/ReplicationService.js';
import InteractionService from '../../services/v1/InteractionService.js';
import TestRunService from '../../services/v1/TestRunService.js';
import { isTestRunsPreviewEnabled } from '../../config/testRuns.js';
import { ownsReplication } from '../../utils/replicationOwnership.js';

export const generateSpectateToken = async (req, res, next) => {
  try {
    const { id: sessionId } = req.params;
    const { expiresIn = 3600 } = req.body;
    const canManageReplication = Boolean(req.canManageReplication ?? req.user?.isAdmin);
    await SessionService.checkReplicationAccess(sessionId, canManageReplication, req.user?.shareToken);
    const result = await SpectatorService.generateSpectateToken(sessionId, expiresIn);
    const spectateUrl = SpectatorService.generateSpectateUrl(sessionId, result.token);

    res.status(200).json({
      ...result,
      spectateUrl,
    });
  } catch (error) {
    next(error);
  }
};

export const getSessionForSpectator = async (req, res, next) => {
  try {
    const { id: sessionId } = req.params;

    // Verify token (already done in middleware)
    // Token payload is in req.spectateSession / req.spectateRun

    if (req.spectateSession !== sessionId) {
      let authorizedByRun = false;
      if (req.spectateRun) {
        const target = await SessionRepository.findById(sessionId);
        authorizedByRun = Boolean(target?.run && String(target.run) === String(req.spectateRun));
      }
      if (!authorizedByRun) {
        const error = new Error('Spectate token does not match session');
        error.statusCode = 403;
        throw error;
      }
    }

    const data = await InteractionService.getSessionData(sessionId)

    res.json(data)
  } catch (error) {
    next(error);
  }
};

export const getLiveSessionsByReplication = async (req, res, next) => {
  try {
    const { id: replicationId } = req.params;
    const { userId } = req.query;

    const options = {};
    if (userId) {
      options.userId = userId;
    }
    const replication = req.replication ?? (await ReplicationService.findById(replicationId));
    const canManageReplication = Boolean(
      req.canManageReplication ??
        (req.user?.isAdmin || (replication && ownsReplication(replication, req.user)))
    );
    await ReplicationService.checkAccess(replicationId, canManageReplication, req.user?.shareToken);
    const sessions = await SessionRepository.findByReplicationAndPopulateMessages(replicationId);
    const stages = Array.isArray(replication?.experiment?.stages) ? replication.experiment.stages : [];
    const stageIndexById = new Map(stages.filter((stage) => stage?.id).map(({ id }, index) => [id, index]));
    const stageTotal = stages.length || null;
    // Test runs recorded so far, so the dashboard keeps them across a refresh
    // (live ones arrive afterwards as session:testRun events).
    const testRunsBySession = isTestRunsPreviewEnabled()
      ? await TestRunService.liveSummariesBySession(replicationId)
      : null;

    // Format sessions for dashboard
    const formattedSessions = sessions.map((session) => {
      const messages = Array.isArray(session.messages) ? session.messages.filter(Boolean) : [];
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
      const resolvedStageIndex =
        typeof session.stageIndex === 'number'
          ? session.stageIndex
          : session.stageId && stageIndexById.has(session.stageId)
            ? stageIndexById.get(session.stageId)
            : null;
      const flags =
        canManageReplication && Array.isArray(session.supervisorFlags)
          ? session.supervisorFlags
          : undefined;
      const testRuns = testRunsBySession?.get(String(session.id));

      return {
        id: session.id,
        runId: session.run ? String(session.run) : null,
        stageId: session.stageId || null,
        stageNumber: resolvedStageIndex !== null ? resolvedStageIndex + 1 : null,
        stageTotal,
        user: session.user,
        leia: session.leia,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt,
        isActive: !session.finishedAt,
        score: session.score ?? null,
        evaluationMode: session.evaluationMode || (session.rubricEvaluation ? 'rubric' : session.evaluation ? 'classic' : null),
        evaluation: session.evaluation ?? null,
        rubricEvaluation: session.rubricEvaluation ?? null,
        messageCount: messages.length,
        ...(testRunsBySession && {
          testRunCount: testRuns?.testRunCount || 0,
          testRuns: testRuns?.testRuns || [],
        }),
        lastMessage: lastMessage
          ? {
            text: lastMessage.text,
            isLeia: lastMessage.isLeia,
            timestamp: lastMessage.timestamp,
          }
          : null,
        ...(flags ? { supervisorFlags: flags, supervisorFlagCount: flags.length } : {}),
      };
    });

    res.status(200).json({
      sessions: formattedSessions,
      total: formattedSessions.length,
    });
  } catch (error) {
    next(error);
  }
};
