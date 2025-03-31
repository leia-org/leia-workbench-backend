import Replication from '../../models/Replication.js';

class ReplicationRepository {
  // READ METHODS

  async findAll() {
    return await Replication.find();
  }

  async findById(id) {
    return await Replication.findById(id);
  }

  // WRITE METHODS

  async create(replicationData) {
    const replication = new Replication(replicationData);
    return await replication.save();
  }

  async update(id, replicationData) {
    return await Replication.findByIdAndUpdate(id, replicationData, { new: true });
  }

  async regenerateCode(id) {
    const replication = await Replication.findById(id);
    if (!replication) {
      throw new Error('Replication not found');
    }
    await replication.regenerateCode();
    return await replication.save();
  }

  async toggleIsActive(id) {
    return await Replication.findByIdAndUpdate(id, [{ $set: { isActive: { $not: '$isActive' } } }], { new: true });
  }

  async updateLeiaRunnerConfig(id, leiaId, runnerConfig) {
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      { $set: { 'experiment.leias.$.runnerConfig': runnerConfig } },
      { new: true }
    );
  }
}

export default new ReplicationRepository();
