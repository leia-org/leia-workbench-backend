import TestRun from '../../models/TestRun.js';

// Chronological order; _id breaks ties between runs stored in the same ms.
const CHRONOLOGICAL = { createdAt: 1, _id: 1 };

class TestRunRepository {
  // READ METHODS

  async countBySession(sessionId) {
    return await TestRun.countDocuments({ session: sessionId });
  }

  async findBySessionAndClientRunId(sessionId, clientRunId) {
    return await TestRun.findOne({ session: sessionId, clientRunId });
  }

  // Summaries (no code snapshot) for list payloads.
  async findSummariesByReplication(replicationId) {
    return await TestRun.find({ replication: replicationId }).select('-code').sort(CHRONOLOGICAL);
  }

  // Full runs, including the code snapshot.
  async findByReplication(replicationId) {
    return await TestRun.find({ replication: replicationId }).sort(CHRONOLOGICAL);
  }

  // Filtering on both ids keeps a session of another replication out of reach
  // of a caller that was only authorised for `replicationId`.
  async findBySessionAndReplication(sessionId, replicationId) {
    return await TestRun.find({ session: sessionId, replication: replicationId }).sort(CHRONOLOGICAL);
  }

  // Most recent student-triggered runs the LEIA has not been told about,
  // returned oldest first.
  async findUnreportedStudentRuns(sessionId, limit) {
    const runs = await TestRun.find({ session: sessionId, trigger: 'student', reportedToLeiaAt: null })
      .select('-code')
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit);
    return runs.reverse();
  }

  async countUnreportedStudentRuns(sessionId) {
    return await TestRun.countDocuments({ session: sessionId, trigger: 'student', reportedToLeiaAt: null });
  }

  // WRITE METHODS

  async create(testRunData) {
    const testRun = new TestRun(testRunData);
    return await testRun.save();
  }

  // Runs created after `upTo` stay pending: they were not part of the note.
  async markStudentRunsReported(sessionId, upTo, reportedAt = new Date()) {
    return await TestRun.updateMany(
      { session: sessionId, trigger: 'student', reportedToLeiaAt: null, createdAt: { $lte: upTo } },
      { $set: { reportedToLeiaAt: reportedAt } }
    );
  }
}

export default new TestRunRepository();
