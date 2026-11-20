export const referencePattern = /{{\s*previousStage\.outputs\.(conversation|submitedSolution)\s*}}/g;
const anyReference = /{{\s*previousStage\b[^{}]*}}/g;
export const STAGE_OUTPUTS = ['conversation', 'submitedSolution'];

export function activityError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function getStageOutputSource(stage, output) {
  return stage?.outputSources?.[output] ?? null;
}

export function getStageReferencedOutputs(leias) {
  const outputs = new Set();
  for (const entry of leias || []) {
    const description = entry?.leia?.spec?.behaviour?.spec?.description || '';
    for (const match of description.matchAll(referencePattern)) {
      outputs.add(match[1]);
    }
  }
  return outputs;
}

export function getStageOutputSourcesMap(stage, leias) {
  const referenced = getStageReferencedOutputs(leias);
  const sources = {};
  for (const output of referenced) {
    const sourceId = getStageOutputSource(stage, output);
    if (sourceId) sources[output] = sourceId;
  }
  return sources;
}

export function getStagesRequiringSolution(experiment) {
  const requiredByStageId = new Map();
  const stages = experiment?.stages;
  if (!Array.isArray(stages) || !stages.length) return requiredByStageId;
  const positions = new Map(stages.map(({ id }, index) => [id, index]));

  for (const [index, stage] of stages.entries()) {
    const entries = (experiment.leias || []).filter((entry) => entry.stageId === stage.id);
    const referenced = getStageReferencedOutputs(entries);
    if (!referenced.has('submitedSolution')) continue;
    const sourceStageId = getStageOutputSource(stage, 'submitedSolution');
    if (!sourceStageId || !(positions.get(sourceStageId) < index)) continue;
    const dependents = requiredByStageId.get(sourceStageId) || [];
    dependents.push(index + 1);
    requiredByStageId.set(sourceStageId, dependents);
  }

  return requiredByStageId;
}

export function getSolutionRequirementForLeia(experiment, leia) {
  if (!experiment?.stages || !leia?.stageId) return null;
  const dependents = getStagesRequiringSolution(experiment).get(leia.stageId);
  return dependents?.length ? dependents : null;
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
    const referencedOutputs = new Set(supportedReferences.map((match) => match[1]));
    for (const output of STAGE_OUTPUTS) {
      const sourceId = getStageOutputSource(stage, output);
      if ((referencedOutputs.has(output) || sourceId) && !(positions.get(sourceId) < index)) {
        throw activityError(`Stage ${number} requires a valid earlier stage`);
      }
    }
    const conversationSourceId = getStageOutputSource(stage, 'conversation');
    if (referencedOutputs.has('conversation') && conversationSourceId) {
      const sourceIndex = positions.get(conversationSourceId);
      const sourceEntries = experiment.leias.filter((entry) => entry.stageId === conversationSourceId);
      if (sourceEntries.some((entry) => entry.configuration?.mode === 'transcription')) {
        throw activityError(
          `Stage ${sourceIndex + 1} cannot use transcription mode because stage ${number} uses its conversation`
        );
      }
    }
    return flow;
  });
}
