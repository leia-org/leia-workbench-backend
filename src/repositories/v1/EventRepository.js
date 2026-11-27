import mongoose from 'mongoose';
import Event from '../../models/Event.js';

// Order of a session's timeline; `seq` and `_id` break ties inside one batch.
const TIMELINE = { at: 1, seq: 1, _id: 1 };

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

class EventRepository {
  // READ METHODS

  // Which of these client ids the session already stored (idempotency).
  async findByClientEventIds(sessionId, clientEventIds) {
    if (clientEventIds.length === 0) return [];
    return await Event.find({ session: sessionId, clientEventId: { $in: clientEventIds } }).select('clientEventId at');
  }

  async findBySessionAndClientEventId(sessionId, clientEventId, { withContent = false } = {}) {
    const query = Event.findOne({ session: sessionId, clientEventId });
    return await (withContent ? query.select('+content') : query);
  }

  // { type: count } for one session.
  async countsByTypeForSession(sessionId) {
    const rows = await Event.aggregate([
      { $match: { session: toObjectId(sessionId) } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map((row) => [row._id, row.count]));
  }

  // [{ session, type, count }] for every session of a replication.
  async countsByReplication(replicationId) {
    const rows = await Event.aggregate([
      { $match: { replication: toObjectId(replicationId) } },
      { $group: { _id: { session: '$session', type: '$type' }, count: { $sum: 1 } } },
    ]);
    return rows.map((row) => ({ session: String(row._id.session), type: row._id.type, count: row.count }));
  }

  // Events of one session, without content unless asked. Filtering on both
  // ids keeps a session of another replication out of reach of a caller that
  // was only authorised for `replicationId`.
  async findBySession(sessionId, replicationId, { type, withContent = false } = {}) {
    const query = Event.find({ session: sessionId, replication: replicationId, ...(type ? { type } : {}) }).sort(TIMELINE);
    return await (withContent ? query.select('+content') : query);
  }

  async findOneWithContent(eventId, sessionId, replicationId) {
    return await Event.findOne({ _id: eventId, session: sessionId, replication: replicationId }).select('+content');
  }

  async findByReplication(replicationId, { type, withContent = false } = {}) {
    const query = Event.find({ replication: replicationId, ...(type ? { type } : {}) }).sort({ session: 1, ...TIMELINE });
    return await (withContent ? query.select('+content') : query);
  }

  // Most recent events matching `filter` that the LEIA has not been told
  // about, returned oldest first.
  async findUnreported(sessionId, filter, limit) {
    const events = await Event.find({ session: sessionId, ...filter, reportedToLeiaAt: null })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit);
    return events.reverse();
  }

  async countUnreported(sessionId, filter) {
    return await Event.countDocuments({ session: sessionId, ...filter, reportedToLeiaAt: null });
  }

  // WRITE METHODS

  async create(eventData) {
    const event = new Event(eventData);
    return await event.save();
  }

  // Events received after `upTo` stay pending: they were not part of the note.
  async markReported(sessionId, filter, upTo, reportedAt = new Date()) {
    return await Event.updateMany(
      { session: sessionId, ...filter, reportedToLeiaAt: null, createdAt: { $lte: upTo } },
      { $set: { reportedToLeiaAt: reportedAt } }
    );
  }

  async deleteBySession(sessionId) {
    return await Event.deleteMany({ session: sessionId });
  }
}

export default new EventRepository();
