import ActivityRunRepository from '../../repositories/v1/ActivityRunRepository.js';

class ActivityRunService {
  async findById(id) {
    return await ActivityRunRepository.findById(id);
  }

  async findLatestByUserAndReplication(userId, replicationId) {
    return await ActivityRunRepository.findLatestByUserAndReplication(userId, replicationId);
  }

  async findByReplication(replicationId) {
    return await ActivityRunRepository.findByReplication(replicationId);
  }

  async createOnce(data) {
    return await ActivityRunRepository.createOnce(data);
  }

  async attachStageSession(runId, entry) {
    return await ActivityRunRepository.attachStageSession(runId, entry);
  }

  async markFinished(runId, finishedAt) {
    return await ActivityRunRepository.markFinished(runId, finishedAt);
  }
}

export default new ActivityRunService();
