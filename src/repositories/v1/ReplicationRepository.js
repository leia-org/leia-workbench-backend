import mongoose from 'mongoose';
import Replication from '../../models/Replication.js';

class ReplicationRepository {
  // READ METHODS

  async findAll() {
    return await Replication.find();
  }
  async findAllByUser(userId) {
    return await Replication.find({
       $or: [{ 'experiment.user.id': userId }, { 'experiment.user._id': userId }, { 'experiment.user': userId }],
     });
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

  async checkSharedAccess(id, token) {
    return !!(await Replication.exists({ _id: id, isShared: true, shareToken: token }));
  }

  async existsByName(name) {
    return await Replication.exists({ name });
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

  async regenerateShareToken(id) {
    const replication = await Replication.findById(id);
    if (!replication) {
      throw new Error('Replication not found');
    }
    replication.regenerateShareToken();
    return await replication.save();
  }

  async toggleIsActive(id) {
    return await Replication.findByIdAndUpdate(id, [{ $set: { isActive: { $not: '$isActive' } } }], { new: true });
  }

  async toggleIsShared(id) {
    const replication = await Replication.findById(id);
    if (!replication) {
      throw new Error('Replication not found');
    }

    if (!replication.isShared && !replication.shareToken) {
      replication.regenerateShareToken();
    }

    replication.isShared = !replication.isShared;
    return await replication.save();
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

  async incrementLeiaScenarioCount(id, leiaId, scenarioIndex) {
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      { $inc: { [`experiment.leias.$.scenarioCounts.${scenarioIndex}`]: 1 } },
      { new: true }
    );
  }

  // Same least-count balancing as getAndIncrementNextLeia, applied to which
  // of the 4 scenario variants is served within a single leia, instead of
  // Math.random() (which can repeat the same number several sessions in a
  // row). Scoped per-leia, not per-replication: each leia/pattern has its
  // own scenario pool.
  async getAndIncrementNextScenario(id, leiaId) {
    const replication = await Replication.findById(id, {
      'experiment.leias.id': 1,
      'experiment.leias.scenarioCounts': 1,
    });
    if (!replication) {
      throw new Error('Replication not found');
    }
    leiaId = new mongoose.Types.ObjectId(String(leiaId));
    const leia = replication.experiment?.leias?.find((l) => leiaId.equals(l.id));
    if (!leia) {
      throw new Error('Leia not found in the replication experiment');
    }

    // Leias created before this feature (or added without going through
    // initializeExperiment) may not have scenarioCounts yet — treat as
    // all-zero rather than failing the session.
    const counts = leia.scenarioCounts?.length === 4 ? leia.scenarioCounts : [0, 0, 0, 0];

    // Find the scenario index with the least uses so far (ties go to the
    // lowest index, same tie-break as getAndIncrementNextLeia).
    let nextIndex = 0;
    for (let i = 1; i < counts.length; i++) {
      if (counts[i] < counts[nextIndex]) {
        nextIndex = i;
      }
    }

    await this.incrementLeiaScenarioCount(id, leia.id, nextIndex);

    return nextIndex + 1;
  }
}

export default new ReplicationRepository();
