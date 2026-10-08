import ReplicationService from './ReplicationService.js';
import Session from '../../models/Session.js';
import MessageService from './MessageService.js';
import SessionService from './SessionService.js';
import RunnerService from './RunnerService.js';
import logger from '../../utils/logger.js';

export function getDynamics(leia) {
  return leia?.leia?.spec?.behaviour?.spec?.conversationDynamics || {};
}

export function publicDynamicsState(session, leia) {
  const supported = session.interactionMode !== 'multi';
  const controlled = supported && getDynamics(leia).stoppingCondition?.enabled === true;
  const satisfied = session.conversationDynamicsState?.stoppingCondition?.satisfied === true;
  return {
    canFinish: !controlled || satisfied,
    leiaSpeaksFirst: { enabled: supported && getDynamics(leia).leiaSpeaksFirst?.enabled === true,
      completed: session.conversationDynamicsState?.leiaSpeaksFirst?.completed === true || (session.messages?.length || 0) > 0 },
    stoppingCondition: { enabled: controlled, satisfied },
  };
}

export function dynamicsInstructions(leia) {
  const stopping = getDynamics(leia).stoppingCondition;
  return stopping?.enabled === true
    ? `Conversation stopping condition: ${stopping.config.condition}\nWhen this condition is met, conclude naturally and tell the student the conversation has ended.`
    : '';
}

class ConversationDynamicsService {
  observations = new Map();

  async getState(sessionId) {
    const session = await SessionService.findById(sessionId);
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
    // Retry failed decisions against the saved transcript, without blocking
    // the status response or losing an already generated assistant message.
    void this.observeSafely(sessionId, leia);
    return publicDynamicsState(session, leia);
  }

  async assertCanFinish(session, leia) {
    if (!leia) {
      const error = new Error('Leia not found');
      error.statusCode = 404;
      throw error;
    }
    if (!publicDynamicsState(session, leia).canFinish) {
      const error = new Error('LEIA has not yet decided to end the conversation');
      error.statusCode = 403;
      throw error;
    }
  }

  // Only persisted assistant turns can trigger a decision. Never accept a
  // client-supplied condition, transcript or satisfied flag.
  async observe(sessionId, leia) {
    const session = await SessionService.findById(sessionId);
    const stopping = getDynamics(leia).stoppingCondition;
    if (!session || session.finishedAt || stopping?.enabled !== true ||
        session.conversationDynamicsState?.stoppingCondition?.satisfied) return;
    const messages = await MessageService.findBySession(sessionId);
    const latest = messages.at(-1);
    if (!latest?.isLeia || !messages.some((message) => !message.isLeia)) return;
    if (String(session.conversationDynamicsState?.stoppingCondition?.lastMessageId) === String(latest.id)) return;
    const decision = await RunnerService.evaluateStoppingCondition(stopping.config.condition,
      messages.map((message) => ({ role: message.isLeia ? 'leia' : 'student', text: message.text })),
      leia.leia?.spec?.behaviour?.spec?.description, leia.runnerConfiguration);
    // A fulfilled condition is monotonic, including across concurrent turns.
    await Session.updateOne({ _id: sessionId, 'conversationDynamicsState.stoppingCondition.satisfied': { $ne: true } },
      { $set: { 'conversationDynamicsState.stoppingCondition': {
        satisfied: decision.satisfied === true, lastMessageId: String(latest.id),
        ...(decision.satisfied === true ? { decidedAt: new Date() } : {}),
      } } });
  }

  async observeSafely(sessionId, leia) {
    if (this.observations.has(String(sessionId))) return this.observations.get(String(sessionId));
    const work = this.observe(sessionId, leia)
      .catch((error) => logger.error(`Stopping condition evaluation failed for ${sessionId}: ${error.message}`))
      .finally(() => this.observations.delete(String(sessionId)));
    this.observations.set(String(sessionId), work);
    await work;
  }

  // An expiring claim prevents duplicate openings on reconnects / concurrent
  // starts. A failed generation releases its claim for the next retry.
  async open(sessionId, leia, send, awaitDelivery = false, owner = 'text') {
    const first = getDynamics(leia).leiaSpeaksFirst;
    if (first?.enabled !== true) return;
    const messages = await MessageService.findBySession(sessionId);
    if (messages.length) return;
    const claim = await Session.findOneAndUpdate({ _id: sessionId, finishedAt: null,
      'conversationDynamicsState.leiaSpeaksFirst.completed': { $ne: true },
      $or: [
        { 'conversationDynamicsState.leiaSpeaksFirst.claimedAt': { $exists: false } },
        { 'conversationDynamicsState.leiaSpeaksFirst.claimedAt': { $lt: new Date(Date.now() - 120000) } },
      ],
    }, { $set: { 'conversationDynamicsState.leiaSpeaksFirst.claimedAt': new Date(), 'conversationDynamicsState.leiaSpeaksFirst.claimedBy': owner } }, { new: true });
    if (!claim) return;
    try {
      await send(`Start the conversation now. This is an internal startup instruction, not a student message. Your first message must follow these instructor instructions: ${first.config.firstMessage}`);
      if (!awaitDelivery) await this.completeOpening(sessionId);
    } catch (error) {
      await Session.updateOne({ _id: sessionId }, { $unset: { 'conversationDynamicsState.leiaSpeaksFirst.claimedAt': 1 } });
      throw error;
    }
  }

  async releaseOpening(sessionId, owner) {
    await Session.updateOne({ _id: sessionId,
      'conversationDynamicsState.leiaSpeaksFirst.claimedBy': owner,
      'conversationDynamicsState.leiaSpeaksFirst.completed': { $ne: true } },
      { $unset: { 'conversationDynamicsState.leiaSpeaksFirst.claimedAt': 1,
        'conversationDynamicsState.leiaSpeaksFirst.claimedBy': 1 } });
  }

  async completeOpening(sessionId) {
    await Session.updateOne({ _id: sessionId }, { $set: { 'conversationDynamicsState.leiaSpeaksFirst.completed': true } });
  }

  async openText(sessionId, leia) {
    if (leia.runnerConfiguration?.audioMode) return;
    await this.open(sessionId, leia, async (instruction) => {
      const response = await RunnerService.sendMessage(sessionId, instruction);
      const text = typeof response === 'string' ? response : response?.message;
      if (!text) throw new Error('LEIA did not return an opening message');
      const message = await MessageService.create(text, true, sessionId);
      await SessionService.addMessage(sessionId, message.id);
    });
  }
}

export default new ConversationDynamicsService();
