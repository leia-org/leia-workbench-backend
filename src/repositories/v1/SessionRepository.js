import Session from '../../models/Session.js';

class SessionRepository {
  // READ METHODS

  async findAll() {
    return await Session.find({ isTest: false });
  }

  async findById(id) {
    return await Session.findById(id);
  }

  async findByIdAndPopulateMessages(id) {
    return await Session.findById(id).populate('messages');
  }

  async findByReplication(replicationId) {
    return await Session.find({ replication: replicationId, isTest: false });
  }

  async findByReplicationAndPopulateMessages(replicationId) {
    return await Session.find({ replication: replicationId, isTest: false })
      .populate('messages')
      .populate('user', 'email');
  }

  async findByReplicationAndLeia(replicationId, leiaId) {
    return await Session.find({ replication: replicationId, leia: leiaId, isTest: false });
  }

  async findFinishedByReplication(replicationId) {
    return await Session.find({ replication: replicationId, finishedAt: { $ne: null }, isTest: false });
  }

  async hasReplicationStarted(replicationId) {
    return await Session.exists({ replication: replicationId, startedAt: { $ne: null }, isTest: false });
  }

  // Indexed

  async findByUser(userId) {
    return await Session.find({ user: userId, isTest: false });
  }

  async findByUserAndReplication(userId, replicationId) {
    return await Session.find({ user: userId, replication: replicationId });
  }

  async findOneUnfinishedByUserAndReplication(userId, replicationId) {
    return await Session.findOne({
      user: userId,
      replication: replicationId,
      finishedAt: null,
      isTest: false,
    });
  }

  async hasAnyFinished(userId, replicationId) {
    return await Session.exists({ user: userId, replication: replicationId, finishedAt: { $ne: null }, isTest: false });
  }

  // WRITE METHODS
  async create(sessionData) {
    const session = new Session(sessionData);
    return await session.save();
  }

  async update(id, sessionData) {
    return await Session.findByIdAndUpdate(id, sessionData, { new: true });
  }

  async addMessage(id, messageId) {
    return await Session.findByIdAndUpdate(id, { $push: { messages: messageId } }, { new: true });
  }
}

export default new SessionRepository();
