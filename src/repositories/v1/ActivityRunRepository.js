import ActivityRun from '../../models/ActivityRun.js';

class ActivityRunRepository {
  async findById(id) {
    return await ActivityRun.findById(id);
  }

  async findLatestByUserAndReplication(user, replication) {
    return await ActivityRun.findOne({ user, replication, isTest: false }).sort({
      startedAt: -1,
      _id: -1,
    });
  }

  async findByReplication(replicationId) {
    return await ActivityRun.find({ replication: replicationId, isTest: false }).sort({
      startedAt: -1,
      _id: -1,
    });
  }

  async create(data) {
    const run = new ActivityRun(data);
    return await run.save();
  }

  async createOnce(data) {
    try {
      const run = await this.create(data);
      return { run, created: true };
    } catch (error) {
      if (error.code !== 11000 || !error.keyPattern?.runKey) throw error;
      return { run: await ActivityRun.findOne({ runKey: data.runKey }), created: false };
    }
  }

  async attachStageSession(runId, { stageId, stageIndex, sessionId }) {
    const updated = await ActivityRun.findOneAndUpdate(
      { _id: runId, 'stages.stageId': { $ne: stageId } },
      {
        $push: { stages: { stageId, stageIndex, session: sessionId } },
        $max: { currentStageIndex: stageIndex },
      },
      { new: true }
    );
    return updated || (await ActivityRun.findById(runId));
  }

  async markFinished(runId, finishedAt = new Date()) {
    const updated = await ActivityRun.findOneAndUpdate(
      { _id: runId, finishedAt: null },
      { $set: { finishedAt } },
      { new: true }
    );
    return updated || (await ActivityRun.findById(runId));
  }
}

export default new ActivityRunRepository();
