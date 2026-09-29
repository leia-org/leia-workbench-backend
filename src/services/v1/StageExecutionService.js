import { randomUUID } from 'node:crypto';
import SessionService from './SessionService.js';
import MessageService from './MessageService.js';
import RunnerService from './RunnerService.js';
import { collectStageArtifacts, validateStages, nextStage, stageReferences } from '../../utils/stages.js';
import runtime from '../../utils/reflectiveRuntime.cjs';

const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};
export { nextStage } from '../../utils/stages.js';
export const stageOrchestration = (session) => ({
  mode: 'multi',
  maxInternalTurns: 2,
  ...session.stageSnapshot?.config?.orchestration,
});

// Runtime adapters are registered independently of the activity sequencer. A new
// stage can prepare arbitrary persisted state and initialize its own runtime.
const executors = new Map();
export function registerStageExecutor(type, executor) {
  if (executors.has(type) || typeof executor.prepare !== 'function' || typeof executor.initialize !== 'function') {
    throw new Error(`Invalid or duplicate stage executor: ${type}`);
  }
  executors.set(type, Object.freeze(executor));
}
function executorFor(stage) {
  const executor = executors.get(stage.type);
  if (!executor) fail(`No runtime registered for stage: ${stage.type}`);
  return executor;
}
function prepareConversation({ stage, replication, previousStage }, interactionMode) {
  const ids = stage.config.leiaIds || [stage.config.leiaId];
  const orchestration = stage.config.orchestration || {};
  const leiaId = orchestration.problemLeiaId || orchestration.openingLeiaId || ids[0];
  const entries = ids.map((id) => {
    const entry = structuredClone(
      replication.experiment.leias.find((candidate) => String(candidate.id) === String(id))
    );
    runtime.instantiateLeia(entry.leia, previousStage);
    return entry;
  });
  const primary = entries.find((entry) => String(entry.id) === String(leiaId));
  return {
    leiaId,
    interactionMode,
    leias: ids,
    stageEntries: entries,
    leiaSnapshot:
      interactionMode === 'single' && stageReferences(primary).length
        ? { ...primary.leia, spec: { ...primary.leia.spec, previousStage } }
        : undefined,
  };
}
function withStageContext(entry, session) {
  return { ...entry, leia: { ...entry.leia, spec: { ...entry.leia.spec, previousStage: session.previousStage } } };
}
registerStageExecutor('LEIAStage', {
  prepare: (context) => prepareConversation(context, 'single'),
  initialize: (session, replication) =>
    RunnerService.initializeRunner(
      session.id,
      withStageContext(session.stageEntries[0], session),
      replication.language
    ),
});
registerStageExecutor('MultiLEIAStage', {
  prepare: (context) => prepareConversation(context, 'multi'),
  async initialize(session) {
    const result = await RunnerService.initializeMultiLeia(
      session.id,
      session.stageEntries.map((entry) => withStageContext(entry, session)),
      stageOrchestration(session)
    );
    if (result?.state) await SessionService.updateMultiLeiaState(session.id, result.state);
  },
});
registerStageExecutor('StaticContentStage', {
  prepare: () => ({ interactionMode: 'static', stageEntries: [], leias: [] }),
  initialize: async () => {},
});

class StageExecutionService {
  async start(replication, userId, isTest = false, previous = null) {
    validateStages(replication.experiment);
    if (
      previous &&
      (!previous.finishedAt ||
        String(previous.replication) !== String(replication.id) ||
        String(previous.user) !== String(userId))
    )
      fail('Previous stage must be completed in this activity execution', 409);
    const stage = previous ? nextStage(replication, previous) : replication.experiment.stages[0];
    if (!stage) fail('No stage available');
    let session = previous ? await SessionService.findByPreviousSession(previous.id) : null;
    if (!session) {
      const previousStage = previous
        ? collectStageArtifacts(previous.stageSnapshot, {
            session: previous,
            messages: await MessageService.findBySession(previous.id),
          })
        : {};
      const { leiaId, ...prepared } = await executorFor(stage).prepare({ stage, replication, previousStage });
      try {
        session = await SessionService.create(userId, replication.id, leiaId, isTest, {
          activityRunId: previous?.activityRunId || randomUUID(),
          stageId: stage.id,
          stageSnapshot: stage,
          previousStage,
          previousSession: previous?.id,
          ...prepared,
        });
      } catch (error) {
        if (error.code !== 11000 || !previous) throw error;
        session = await SessionService.findByPreviousSession(previous.id);
        if (!session) throw error;
      }
    }
    await this.initialize(session, replication);
    return session.id;
  }

  async initialize(session, replication) {
    if (session.isRunnerInitialized || session.finishedAt) return;
    try {
      await executorFor(session.stageSnapshot).initialize(session, replication);
    } catch (error) {
      if (error.response?.status !== 409) throw error;
    }
    await SessionService.updateIsRunnerInitialized(session.id, true);
  }
}
export default new StageExecutionService();
