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

  async findActiveByReplication(replicationId, options = {}) {
    const query = {
      replication: replicationId,
      finishedAt: null,
      isTest: false,
    };

    if (options.userId) {
      query.user = options.userId;
    }

    return await Session.find(query)
      .populate('user', 'email')
      .populate('messages')
      .sort({ startedAt: -1 });
  }

  async findWithMessagesSince(sessionId, timestamp) {
    return await Session.findById(sessionId).populate({
      path: 'messages',
      match: { timestamp: { $gt: new Date(timestamp) } },
      options: { sort: { timestamp: 1 } },
    });
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

  async clearMessages(id) {
    return await Session.findByIdAndUpdate(id, { $set: { messages: [] } }, { new: true });
  }

  // Append supervisor flags (if any) and advance the observation state in one write.
  async appendSupervisorObservation(id, flags, supervisorState) {
    const update = { $set: { supervisorState } };
    if (Array.isArray(flags) && flags.length > 0) {
      update.$push = { supervisorFlags: { $each: flags } };
    }
    return await Session.findByIdAndUpdate(id, update, { new: true });
  }

  // Clear a delivered student nudge. When `value` is given, only clear if the
  // stored nudge still equals it — so a nudge written by an in-flight
  // observation between capture and clear isn't clobbered (race-safe).
  async clearPendingNudge(id, value) {
    const filter = { _id: id };
    if (typeof value === 'string') filter['supervisorState.pendingNudge'] = value;
    return await Session.findOneAndUpdate(filter, { $unset: { 'supervisorState.pendingNudge': 1 } }, { new: true });
  }
}

export default new SessionRepository();
