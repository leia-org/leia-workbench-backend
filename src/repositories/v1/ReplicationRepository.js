import mongoose from 'mongoose';
import { replicationOwnershipQuery } from '../../utils/replicationOwnership.js';
import Replication from '../../models/Replication.js';
import { regexQuery } from '../../utils/search.js';
class ReplicationRepository {
  // READ METHODS

  async findAll(lastReplicationId, text) {
    const query = {};
    if (lastReplicationId) {
      query._id = { $gt: new mongoose.Types.ObjectId(`${lastReplicationId}`) };
    }
    if (text) {
      Object.assign(query, regexQuery(text, 'name'));
    }
    const limit = 10;
    const results = await Replication.find(query).sort({ _id: 1 }).limit(limit + 1);
    const replications = results.slice(0, limit);
    const nextCursor = replications.length === limit ? replications[replications.length - 1].id : null;
    return { replications, nextCursor };
  }
  async findAllByUser(userId, lastReplicationId, text) {
    const query = replicationOwnershipQuery(userId);
    if (lastReplicationId) {
      query._id = { $gt: new mongoose.Types.ObjectId(`${lastReplicationId}`) };
    }
    if (text) {
      Object.assign(query, regexQuery(text, 'name'));
    }
    const limit = 10
    const results = await Replication.find(query).sort({ _id: 1 }).limit(limit+1);
    const replications = results.slice(0, limit);
    const nextCursor = replications.length === limit ? replications[replications.length - 1].id : null;
    return {replications, nextCursor};
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

  async updateAskSolution(id, leiaId, askSolution, { clearShowSolution = true } = {}) {
    const update = { 'experiment.leias.$.configuration.askSolution': askSolution };
    if (!askSolution && clearShowSolution) {
      update['experiment.leias.$.configuration.showSolution'] = false;
    }
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      { $set: update },
      { new: true }
    );
  }

  async updateEvaluationConfiguration(id, leiaId, fields) {
    const update = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        update[`experiment.leias.$.configuration.${key}`] = value;
      }
    }
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      { $set: update },
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
    const update = {
      'experiment.leias.$.configuration.askSolution': askSolution,
      'experiment.leias.$.configuration.evaluateSolution': evaluateSolution,
    };
    if (!evaluateSolution) {
      update['experiment.leias.$.configuration.evaluationMode'] = 'none';
    }
    if (!askSolution) {
      update['experiment.leias.$.configuration.showSolution'] = false;
    }
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      { $set: update },
      { new: true }
    );
  }

  async updateShowSolution(id, leiaId, showSolution) {
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      { $set: { 'experiment.leias.$.configuration.showSolution': showSolution } },
      { new: true }
    );
  }

  async updateAskSolutionAndShowSolution(id, leiaId, askSolution, showSolution) {
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      {
        $set: {
          'experiment.leias.$.configuration.askSolution': askSolution,
          'experiment.leias.$.configuration.showSolution': showSolution,
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

  async updateStagePreviousConversation(id, stageId, previousConversation) {
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.stages.id': stageId },
      { $set: { 'experiment.stages.$.previousConversation': previousConversation } },
      { new: true }
    );
  }

  async updateLeiaPreviousStageView(id, leiaId, fields) {
    const update = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        update[`experiment.leias.$.configuration.${key}`] = value;
      }
    }
    return await Replication.findOneAndUpdate(
      { _id: id, 'experiment.leias.id': leiaId },
      { $set: update },
      { new: true }
    );
  }

  async updateStageLeiasPreviousStageView(id, stageId, fields) {
    const update = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        update[`experiment.leias.$[leia].configuration.${key}`] = value;
      }
    }
    return await Replication.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, arrayFilters: [{ 'leia.stageId': stageId }] }
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
