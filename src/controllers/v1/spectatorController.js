import SpectatorService from '../../services/v1/SpectatorService.js';
import SessionRepository from '../../repositories/v1/SessionRepository.js';
import SessionService from '../../services/v1/SessionService.js';
import ReplicationService from '../../services/v1/ReplicationService.js';

export const generateSpectateToken = async (req, res, next) => {
  try {
    const { id: sessionId } = req.params;
    const { expiresIn = 3600 } = req.body;
    await SessionService.checkReplicationAccess(sessionId, req.user.isAdmin, req.user.shareToken);
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
    // Token payload is in req.spectateSession

    if (req.spectateSession !== sessionId) {
      const error = new Error('Spectate token does not match session');
      error.statusCode = 403;
      throw error;
    }

    const session = await SessionRepository.findByIdAndPopulateMessages(sessionId);

    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    res.status(200).json({
      session,
      isActive: !session.finishedAt,
    });
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
    await ReplicationService.checkAccess(replicationId, req.user.isAdmin, req.user.shareToken);
    let sessions = await SessionRepository.findByReplicationAndPopulateMessages(replicationId);

    // Format sessions for dashboard
    const formattedSessions = sessions.map((session) => {
      const messages = session.messages || [];
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

      return {
        id: session.id,
        user: session.user,
        leia: session.leia,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt,
        isActive: !session.finishedAt,
        messageCount: messages.length,
        lastMessage: lastMessage
          ? {
            text: lastMessage.text,
            isLeia: lastMessage.isLeia,
            timestamp: lastMessage.timestamp,
          }
          : null,
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
