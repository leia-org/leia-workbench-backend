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

  // WRITE METHODS

  async create(text, isLeia, sessionId) {
    const messageData = {
      text,
      isLeia,
      session: sessionId,
    };
    const message = await MessageRepository.create(messageData);

    // Emit WebSocket event to spectators and dashboard
    try {
      const session = await SessionRepository.findById(sessionId);
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
}

export default new MessageService();
