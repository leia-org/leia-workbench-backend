import MessageRepository from '../../repositories/v1/MessageRepository.js';
import { emitToSession, emitToReplication } from '../../socket/index.js';
import SessionRepository from '../../repositories/v1/SessionRepository.js';

class MessageService {
  // READ METHODS

  async findAll() {
    return await MessageRepository.findAll();
  }

  async findById(id) {
    return await MessageRepository.findById(id);
  }

  async findBySession(sessionId) {
    return await MessageRepository.findBySession(sessionId);
  }

  shouldSkipConversationPersistence(session) {
    return Boolean(
      session &&
      !session.isTest &&
      session.dataUsage?.consentStatus === 'declined' &&
      session.dataUsage?.config?.dataUsageConsentRequired &&
      session.dataUsage?.config?.conversationAutomatedRemoval
    );
  }

  // WRITE METHODS

  async create(text, isLeia, sessionId) {
    const session = await SessionRepository.findById(sessionId);
    if (this.shouldSkipConversationPersistence(session)) return null;

    const messageData = {
      text,
      isLeia,
      session: sessionId,
    };
    const message = await MessageRepository.create(messageData);

    // Emit WebSocket event to spectators and dashboard
    try {
      if (session) {
        // Emit to session room (spectators)
        emitToSession(sessionId, 'message:new', message);

        // Emit to replication room (dashboard)
        emitToReplication(session.replication.toString(), 'session:message', {
          sessionId,
          message,
        });
      }
    } catch (error) {
      // Don't fail message creation if WebSocket emit fails
      console.error('Failed to emit message via WebSocket:', error);
    }

    return message;
  }

  async deleteBySession(sessionId) {
    return await MessageRepository.deleteBySession(sessionId);
  }
}

export default new MessageService();
