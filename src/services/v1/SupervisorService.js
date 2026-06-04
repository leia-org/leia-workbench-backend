import SessionService from './SessionService.js';
import MessageService from './MessageService.js';
import RunnerService from './RunnerService.js';
import { emitToReplicationAdmins } from '../../socket/index.js';
import logger from '../../utils/logger.js';

const DEFAULT_EVERY_N = 4;
const TRANSCRIPT_WINDOW = 12; // messages of context sent to the supervisor

// Background supervisor: a per-LEIA LLM (configured by the instructor in the
// designer, at `leia.leia.spec.supervisorConfig`) that observes the activity
// transcript and raises instructor-only flags, optionally nudging the student.
//
// Runs entirely fire-and-forget from the message hooks — it must never block or
// break a student turn, and never expose anything to the student except an
// explicit nudge the instructor enabled.
class SupervisorService {
  // Fire-and-forget: swallow every error, the activity must not be affected.
  observeAsync(sessionId, leia, options = {}) {
    Promise.resolve()
      .then(() => this.observe(sessionId, leia, options))
      .catch((err) => {
        logger.error(`Supervisor observation failed for session ${sessionId}: ${err.message}`);
      });
  }

  async observe(sessionId, leia, options = {}) {
    const supervisorConfig = leia?.leia?.spec?.supervisorConfig;
    if (!supervisorConfig || supervisorConfig.enabled !== true) return;

    // BYOK: the supervisor ALWAYS runs on OpenAI, independent of the LEIA's own
    // provider. Prefer its dedicated OpenAI key (chosen in the designer); fall
    // back to the LEIA's runner key only when that key is itself OpenAI.
    const runnerConfiguration = leia.runnerConfiguration || {};
    const apiKeyId = supervisorConfig.apiKeyId || runnerConfiguration.apiKeyId;
    const apiKeyRequesterId = supervisorConfig.apiKeyRequesterId || runnerConfiguration.apiKeyRequesterId;
    if (!apiKeyId || !apiKeyRequesterId) {
      logger.warn(`Supervisor enabled but no OpenAI BYOK key for session ${sessionId}; skipping.`);
      return;
    }

    const session = await SessionService.findById(sessionId);
    if (!session) return;

    const messages = await MessageService.findBySession(sessionId);
    const totalCount = messages.length;
    if (totalCount === 0) return;

    const state = session.supervisorState || {};
    const lastObserved = Number.isInteger(state.lastObservedCount) ? state.lastObservedCount : 0;

    // Nothing new since the last pass — skip even when forced (e.g. on finish).
    if (totalCount === lastObserved) return;

    const cadence = supervisorConfig.cadence === 'onFinish' ? 'onFinish' : 'everyN';
    const everyN =
      Number.isInteger(supervisorConfig.everyN) && supervisorConfig.everyN > 0
        ? supervisorConfig.everyN
        : DEFAULT_EVERY_N;

    // `force` (session finish) bypasses the cadence gate for a final pass.
    if (!options.force) {
      if (cadence === 'onFinish') return; // only observe at the end
      // Always run the FIRST pass once there's something to look at; afterwards
      // respect the cadence. This way short sessions still get observed and the
      // gate doesn't silently skip the opening exchanges.
      if (lastObserved > 0 && totalCount - lastObserved < everyN) return;
    }

    const window = messages.slice(-TRANSCRIPT_WINDOW).map((m) => ({
      role: m.isLeia ? 'leia' : 'student',
      text: m.text,
    }));

    const result = await RunnerService.observeSupervisor({
      // BYOK identity only. The supervisor ALWAYS runs on OpenAI, so we must not
      // pass the LEIA's modelName here — it may be a non-OpenAI model (gemini,
      // ollama). The supervisor model comes from supervisorConfig.model (else a
      // default OpenAI model on the runner).
      runnerConfiguration: {
        apiKeyId,
        apiKeyRequesterId,
      },
      transcript: window,
      supervisorConfig: {
        instructions: supervisorConfig.instructions,
        categories: supervisorConfig.categories,
        sensitivity: supervisorConfig.sensitivity,
        intervene: supervisorConfig.intervene,
        interveneInstructions: supervisorConfig.interveneInstructions,
        model: supervisorConfig.model,
      },
    });

    const rawFlags = Array.isArray(result?.flags) ? result.flags : [];
    const now = new Date();
    const stampedFlags = rawFlags.map((f) => ({
      category: typeof f.category === 'string' ? f.category : 'observation',
      severity: ['low', 'medium', 'high'].includes(f.severity) ? f.severity : 'low',
      note: typeof f.note === 'string' ? f.note : '',
      quote: typeof f.quote === 'string' && f.quote.trim() ? f.quote : null,
      at: now,
    }));

    // The nudge is only honoured when intervention is enabled and the session
    // is still live (a finished student can't receive it).
    const nudge =
      supervisorConfig.intervene && !session.finishedAt && typeof result?.nudge === 'string' && result.nudge.trim()
        ? result.nudge.trim()
        : null;

    const newState = {
      ...state,
      lastObservedCount: totalCount,
      lastObservedAt: now,
    };
    if (nudge) newState.pendingNudge = nudge;

    await SessionService.appendSupervisorObservation(sessionId, stampedFlags, newState);

    // Surface to the instructor live — ADMIN sockets in the dashboard room only,
    // never the student and never share-token dashboard viewers. The nudge is
    // delivered to the student via the HTTP turn response, not over this channel.
    if (stampedFlags.length > 0) {
      try {
        const totalFlags = (Array.isArray(session.supervisorFlags) ? session.supervisorFlags.length : 0) + stampedFlags.length;
        emitToReplicationAdmins(session.replication.toString(), 'session:supervisorFlag', {
          sessionId,
          flags: stampedFlags,
          flagCount: totalFlags,
        });
      } catch (err) {
        logger.error(`Failed to emit supervisor flag for session ${sessionId}: ${err.message}`);
      }
    }
  }
}

export default new SupervisorService();
