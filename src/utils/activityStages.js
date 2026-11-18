export const referencePattern = /{{\s*previousStage\.outputs\.(conversation|submitedSolution)\s*}}/g;
const anyReference = /{{\s*previousStage\b[^{}]*}}/g;

export function activityError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function stageExperiment(experiment, stage) {
  return {
    leias: experiment.leias.filter((entry) => entry.stageId === stage.id),
    orchestration: stage.orchestration,
  };
}

export function stageProgress(experiment, session) {
  if (!session.stageId) return undefined;
  const stages = experiment.stages || [];
  const index = stages.findIndex(({ id }) => id === session.stageId);
  if (index === -1) return undefined;
  return {
    number: index + 1,
    total: stages.length,
    hasNext: index < stages.length - 1,
  };
}

export function activityFlows(experiment) {
  if (!experiment.stages) return [experiment];
  const positions = new Map(experiment.stages.map(({ id }, index) => [id, index]));
  if (!positions.size || positions.size !== experiment.stages.length ||
      experiment.leias.some(({ stageId }) => !positions.has(stageId))) {
    throw activityError('Invalid activity stages');
  }
  return experiment.stages.map((stage, index) => {
    const number = index + 1;
    const flow = stageExperiment(experiment, stage);
    if (!flow.leias.length || flow.leias.some(({ leia }) => !leia?.spec)) {
      throw activityError(`Stage ${number} requires valid LEIAs`);
    }
    const descriptions = flow.leias.map(({ leia }) => leia.spec.behaviour?.spec?.description || '');
    const references = descriptions.flatMap((description) => [...description.matchAll(anyReference)]);
    const supportedReferences = descriptions.flatMap((description) => [...description.matchAll(referencePattern)]);
    if (references.length !== supportedReferences.length) {
      throw activityError(`Stage ${number} contains an unsupported previous stage output`);
    }
    const hasReferences = references.length > 0;
    if ((hasReferences || stage.previousStageId) && !(positions.get(stage.previousStageId) < index)) {
      throw activityError(`Stage ${number} requires a valid earlier stage`);
    }
    return flow;
  });
}
