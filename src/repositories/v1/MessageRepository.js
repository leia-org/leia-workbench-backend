import Message from '../../models/Message.js';

class MessageRepository {
  // READ METHODS

  async findAll() {
    return await Message.find();
  }

  async findById(id) {
    return await Message.findById(id);
  }

  async findBySession(sessionId) {
    // Explicit chronological order (don't rely on natural/ObjectId order) —
    // the supervisor's transcript window and the rendered history both need it.
    return await Message.find({ session: sessionId }).sort({ timestamp: 1, _id: 1 });
  }

  // WRITE METHODS

  async create(messageData) {
    const message = new Message(messageData);
    return await message.save();
  }
}

export default new MessageRepository();
