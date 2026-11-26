import jwt from 'jsonwebtoken';
import SessionRepository from '../../repositories/v1/SessionRepository.js';
import ReplicationService from './ReplicationService.js';

function resolveLeiaDisplayName(leiaEntry) {
  const personaSpec = leiaEntry?.leia?.spec?.persona?.spec || {};
  const candidates = [
    personaSpec.firstName,
    personaSpec.fullName,
    leiaEntry?.leia?.metadata?.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

class SpectatorService {
  /**
   * Generate spectate token for a session
   * @param {string} sessionId - Session ID
   * @param {number} expiresIn - Expiration time in seconds (default 3600 = 1 hour)
   * @returns {Promise<{token: string, expiresAt: Date}>}
   */
  async generateSpectateToken(sessionId, expiresIn = 3600) {
    // Verify session exists
    const session = await SessionRepository.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    const payload = {
      sessionId,
      type: 'spectate',
      replicationId: session.replication.toString(),
      ...(session.run ? { runId: String(session.run) } : {}),
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn,
    });

    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    return {
      token,
      expiresAt,
      sessionId,
    };
  }

  /**
   * Verify spectate token
   * @param {string} token - JWT token
   * @returns {Object} Decoded token payload
   */
  verifySpectateToken(token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.type !== 'spectate') {
        const error = new Error('Invalid token type');
        error.statusCode = 403;
        throw error;
      }

      return decoded;
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        const err = new Error('Spectate token has expired');
        err.statusCode = 403;
        throw err;
      }
      const err = new Error('Invalid spectate token');
      err.statusCode = 403;
      throw err;
    }
  }

  /**
   * Check whether a spectate token authorizes access to targetSessionId.
   * Authorizes direct matches, sessions in the same ActivityRun, or legacy
   * ancestor stages linked via previousStageSession.
   */
  async isSessionAuthorizedForSpectateToken(targetSessionId, { spectateSession, spectateRun } = {}) {
    if (!targetSessionId || !spectateSession) return false;
    if (String(spectateSession) === String(targetSessionId)) return true;

    if (spectateRun) {
      const target = await SessionRepository.findById(targetSessionId);
      return Boolean(target?.run && String(target.run) === String(spectateRun));
    }

    // Legacy fallback: walk previousStageSession links from the token's session
    const visited = new Set([String(spectateSession)]);
    let cursor = await SessionRepository.findById(spectateSession);
    let hops = 0;
    while (cursor?.previousStageSession && hops < 50) {
      const prevId = String(cursor.previousStageSession);
      if (prevId === String(targetSessionId)) return true;
      if (visited.has(prevId)) break;
      visited.add(prevId);
      cursor = await SessionRepository.findById(prevId);
      hops += 1;
    }
    return false;
  }

  /**
   * Build ordered stage summaries for a staged session so spectators can
   * inspect earlier stages alongside the current live stage.
   */
  async getRunStagesForSession(sessionId, sessionData) {
    const session = sessionData?.session;
    if (!session) return null;

    const runId = session.runId || null;
    const isStaged = Boolean(runId || session.stage || session.stageId);
    if (!isStaged) return null;

    let stageSessions = [];
    if (runId && typeof SessionRepository.findByRun === 'function') {
      const found = await SessionRepository.findByRun(runId);
      if (Array.isArray(found) && found.length > 0) {
        stageSessions = found;
      }
    }

    if (stageSessions.length === 0 && typeof SessionRepository.findById === 'function') {
      const currentDoc = await SessionRepository.findById(sessionId);
      if (currentDoc) {
        const chain = [currentDoc];
        const visited = new Set([String(currentDoc.id || sessionId)]);
        let cursor = currentDoc;
        let hops = 0;
        while (cursor?.previousStageSession && hops < 50) {
          const prevId = String(cursor.previousStageSession);
          if (visited.has(prevId)) break;
          visited.add(prevId);
          const prevDoc = await SessionRepository.findById(prevId);
          if (!prevDoc) break;
          chain.unshift(prevDoc);
          cursor = prevDoc;
          hops += 1;
        }
        stageSessions = chain;
      }
    }

    if (stageSessions.length === 0) return null;

    const replicationId =
      session.replication || sessionData?.replication?.id || stageSessions[0]?.replication || null;
    let replication = null;
    if (replicationId && typeof ReplicationService.findById === 'function') {
      try {
        replication = await ReplicationService.findById(replicationId);
      } catch {
        replication = null;
      }
    }

    const stages = Array.isArray(replication?.experiment?.stages) ? replication.experiment.stages : [];
    const stageIndexById = new Map(stages.filter((stage) => stage?.id).map((stage, idx) => [stage.id, idx]));
    const leiaById = new Map(
      (replication?.experiment?.leias || [])
        .filter((entry) => entry?.id)
        .map((entry) => [String(entry.id), entry])
    );
    const stageTotal = stages.length || session.stage?.total || stageSessions.length;

    return stageSessions
      .map((item, fallbackIndex) => {
        const resolvedStageIndex =
          typeof item.stageIndex === 'number'
            ? item.stageIndex
            : item.stageId && stageIndexById.has(item.stageId)
              ? stageIndexById.get(item.stageId)
              : fallbackIndex;
        const leiaEntry = item.leia ? leiaById.get(String(item.leia)) : null;
        const mode = leiaEntry?.configuration?.mode || 'standard';
        const transcriptionMessages =
          mode === 'transcription' && Array.isArray(leiaEntry?.configuration?.data?.messages)
            ? leiaEntry.configuration.data.messages
            : null;
        const messageCount = transcriptionMessages
          ? transcriptionMessages.length
          : Array.isArray(item.messages)
            ? item.messages.length
            : 0;

        return {
          sessionId: String(item.id || item._id),
          stageId: item.stageId || null,
          stageIndex: resolvedStageIndex,
          stageNumber: resolvedStageIndex + 1,
          stageTotal,
          startedAt: item.startedAt,
          finishedAt: item.finishedAt || null,
          isActive: !item.finishedAt,
          messageCount,
          hasSubmittedSolution: Boolean(typeof item.result === 'string' && item.result.trim()),
          mode,
          leiaName: resolveLeiaDisplayName(leiaEntry),
        };
      })
      .sort((a, b) => {
        if (a.stageIndex !== b.stageIndex) return a.stageIndex - b.stageIndex;
        return new Date(a.startedAt || 0).getTime() - new Date(b.startedAt || 0).getTime();
      });
  }

  /**
   * Generate spectate URL
   * @param {string} sessionId - Session ID
   * @param {string} token - Spectate token
   * @returns {string} Full spectate URL
   */
  generateSpectateUrl(sessionId, token) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return `${frontendUrl}/spectate/${sessionId}?token=${token}`;
  }
}

export default new SpectatorService();
