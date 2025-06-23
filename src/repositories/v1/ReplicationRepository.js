import mongoose from 'mongoose';
import Replication from '../../models/Replication.js';

class ReplicationRepository {
  // READ METHODS

  async findAll() {
    return await Replication.find();
  }

  async findById(id) {
    return await Replication.findById(id);
  }

  async findByCode(code) {
    return await Replication.findOne({ code });
  }

  async findLeia(id, leiaId) {
    const replication = await Replication.findById(id);
    if (replication) {
      leiaId = new mongoose.Types.ObjectId(String(leiaId));
      return replication.experiment.leias.find((l) => leiaId.equals(l.id));
    } else {
      return null;
    }
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

  async toggleIsRepeatable(id) {
    return await Replication.findByIdAndUpdate(id, [{ $set: { isRepeatable: { $not: '$isRepeatable' } } }], {
      new: true,
    });
  }

  async updateAskSolution(id, leiaId, askSolution) {
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      { $set: { 'experiment.leias.$.configuration.askSolution': askSolution } },
      { new: true }
    );
  }

  async updateEvaluateSolution(id, leiaId, evaluateSolution) {
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      { $set: { 'experiment.leias.$.configuration.evaluateSolution': evaluateSolution } },
      { new: true }
    );
  }

  async updateAskSolutionAndEvaluateSolution(id, leiaId, askSolution, evaluateSolution) {
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      {
        $set: {
          'experiment.leias.$.configuration.askSolution': askSolution,
          'experiment.leias.$.configuration.evaluateSolution': evaluateSolution,
        },
      },
      { new: true }
    );
  }

  async updateLeiaRunnerConfiguration(id, leiaId, runnerConfiguration) {
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      { $set: { 'experiment.leias.$.runnerConfiguration': runnerConfiguration } },
      { new: true }
    );
  }

  async incrementLeiaSessionCount(id, leiaId) {
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      { $inc: { 'experiment.leias.$.sessionCount': 1 } },
      { new: true }
    );
  }

  async decrementLeiaSessionCount(id, leiaId) {
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      { $inc: { 'experiment.leias.$.sessionCount': -1 } },
      { new: true }
    );
  }

  async getAndIncrementNextLeia(id) {
    const replication = await Replication.findById(id, {
      'experiment.leias.id': 1,
      'experiment.leias.sessionCount': 1,
    });
    if (!replication) {
      throw new Error('Replication not found');
    }
    const leias = replication.experiment?.leias;
    if (!leias || leias.length === 0) {
      throw new Error('No leias found in the replication experiment');
    }

    // Find leia with the least session count
    const nextLeia = leias.reduce((prev, current) => {
      return prev.sessionCount < current.sessionCount ? prev : current;
    });

    await this.incrementLeiaSessionCount(id, nextLeia.id);

    return nextLeia.id;
  }
}

export default new ReplicationRepository();
