export const PREVIOUS_STAGE_PROBLEM_FIELDS = [
  'description',
  'details',
  'personaBackground',
  'solution',
  'initialSolution',
  'solutionFormat',
  'evaluationPrompt',
  'process',
];
export const referencePattern =
  /{{\s*previousStage\.(?:outputs\.(conversation|submitedSolution)|leia\.problem\.(description|details|personaBackground|solution|initialSolution|solutionFormat|evaluationPrompt|process))\s*}}/g;
const anyReference = /{{\s*previousStage\b[^{}]*}}/g;
export const STAGE_OUTPUTS = ['conversation', 'submitedSolution', 'problem'];
export const PREVIOUS_STAGE_VIEW_AVAILABILITIES = ['chat', 'editor', 'both'];
export const PREVIOUS_CONVERSATION_AVAILABILITIES = PREVIOUS_STAGE_VIEW_AVAILABILITIES;
const outputLabels = {
  conversation: 'conversation',
  submitedSolution: 'submitted solution',
  problem: 'problem',
};

export function activityError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function getStageOutputSource(stage, output) {
  return stage?.outputSources?.[output] ?? null;
}

function resolveTargetLeiaForPreviousStageView(experiment, stage, leia) {
  if (stage?.orchestration?.mode === 'multi') {
    return getStageProblemLeia(experiment, stage);
  }
  return leia || null;
}

export function getLeiaPreviousStageResourceConfig(experiment, stage, leia, resourceKey) {
  const stages = experiment?.stages;
  if (!Array.isArray(stages) || !stage?.id) return null;
  const stageIndex = stages.findIndex(({ id }) => id === stage.id);
  if (stageIndex <= 0) return null;
  const targetLeia = resolveTargetLeiaForPreviousStageView(experiment, stage, leia);
  const config =
    targetLeia?.configuration?.[resourceKey] !== undefined
      ? targetLeia.configuration[resourceKey]
      : stage?.[resourceKey];
  if (!config?.enabled || !config.sourceStageId) return null;
  const sourceStageIndex = stages.findIndex(({ id }) => id === config.sourceStageId);
  if (sourceStageIndex === -1 || !(sourceStageIndex < stageIndex)) return null;
  const availability = PREVIOUS_STAGE_VIEW_AVAILABILITIES.includes(config.availability)
    ? config.availability
    : 'both';
  return {
    enabled: true,
    sourceStageId: config.sourceStageId,
    stageNumber: sourceStageIndex + 1,
    availability,
  };
}

export function getLeiaPreviousConversationConfig(experiment, stage, leia = null) {
  return getLeiaPreviousStageResourceConfig(experiment, stage, leia, 'previousConversation');
}

export function getStagePreviousConversationConfig(experiment, stage, leia = null) {
  return getLeiaPreviousConversationConfig(experiment, stage, leia);
}

export function getLeiaPreviousSubmittedSolutionConfig(experiment, stage, leia = null) {
  return getLeiaPreviousStageResourceConfig(experiment, stage, leia, 'previousSubmittedSolution');
}

function toPublicPreviousStageResourceConfig(config) {
  if (!config) return undefined;
  return {
    enabled: true,
    stageNumber: config.stageNumber,
    availability: config.availability,
  };
}

export function publicPreviousConversationConfig(experiment, stage, leia = null) {
  return toPublicPreviousStageResourceConfig(
    getLeiaPreviousConversationConfig(experiment, stage, leia)
  );
}

export function publicPreviousSubmittedSolutionConfig(experiment, stage, leia = null) {
  return toPublicPreviousStageResourceConfig(
    getLeiaPreviousSubmittedSolutionConfig(experiment, stage, leia)
  );
}

export function stageHasAskSolutionEnabled(experiment, stage) {
  if (!stage?.id) return false;
  const entries = (experiment?.leias || []).filter((entry) => entry.stageId === stage.id);
  if (!entries.length) return false;
  if (stage.orchestration?.mode === 'multi') {
    const problemLeia = getStageProblemLeia(experiment, stage);
    return Boolean(problemLeia && problemLeia.configuration?.askSolution !== false);
  }
  return entries.every((entry) => entry.configuration?.askSolution !== false);
}

export function getStageReferencedOutputs(leias) {
  const outputs = new Set();
  for (const entry of leias || []) {
    const templates = [
      entry?.leia?.spec?.behaviour?.spec?.description || '',
      entry?.leia?.spec?.rubric?.spec?.evaluationPrompt || '',
    ];
    for (const template of templates) {
      for (const match of template.matchAll(referencePattern)) {
        outputs.add(match[1] || 'problem');
      }
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
  const requiredSetsByStageId = new Map();
  const stages = experiment?.stages;
  if (!Array.isArray(stages) || !stages.length) return new Map();
  const positions = new Map(stages.map(({ id }, index) => [id, index]));

  const addDependent = (sourceStageId, stageNumber) => {
    let dependents = requiredSetsByStageId.get(sourceStageId);
    if (!dependents) {
      dependents = new Set();
      requiredSetsByStageId.set(sourceStageId, dependents);
    }
    dependents.add(stageNumber);
  };

  for (const [index, stage] of stages.entries()) {
    const entries = (experiment.leias || []).filter((entry) => entry.stageId === stage.id);
    const referenced = getStageReferencedOutputs(entries);
    if (referenced.has('submitedSolution')) {
      const sourceStageId = getStageOutputSource(stage, 'submitedSolution');
      if (sourceStageId && positions.get(sourceStageId) < index) {
        addDependent(sourceStageId, index + 1);
      }
    }

    if (index > 0) {
      const targetLeias =
        stage.orchestration?.mode === 'multi'
          ? [getStageProblemLeia(experiment, stage)].filter(Boolean)
          : entries;
      for (const entry of targetLeias) {
        const solConfig = getLeiaPreviousSubmittedSolutionConfig(experiment, stage, entry);
        if (solConfig?.sourceStageId && positions.get(solConfig.sourceStageId) < index) {
          addDependent(solConfig.sourceStageId, index + 1);
        }
      }
    }
  }

  const requiredByStageId = new Map();
  for (const [sourceStageId, dependents] of requiredSetsByStageId.entries()) {
    requiredByStageId.set(
      sourceStageId,
      [...dependents].sort((a, b) => a - b)
    );
  }

  return requiredByStageId;
}

export function getSolutionRequirementForLeia(experiment, leia) {
  if (!experiment?.stages || !leia?.stageId) return null;
  const dependents = getStagesRequiringSolution(experiment).get(leia.stageId);
  return dependents?.length ? dependents : null;
}

export function getStagesRequiringConversation(experiment) {
  const requiredByStageId = new Map();
  const stages = experiment?.stages;
  if (!Array.isArray(stages) || !stages.length) return requiredByStageId;
  const positions = new Map(stages.map(({ id }, index) => [id, index]));

  for (const [index, stage] of stages.entries()) {
    const entries = (experiment.leias || []).filter((entry) => entry.stageId === stage.id);
    const referenced = getStageReferencedOutputs(entries);
    if (!referenced.has('conversation')) continue;
    const sourceStageId = getStageOutputSource(stage, 'conversation');
    if (!sourceStageId || !(positions.get(sourceStageId) < index)) continue;
    const dependents = requiredByStageId.get(sourceStageId) || [];
    dependents.push(index + 1);
    requiredByStageId.set(sourceStageId, dependents);
  }

  return requiredByStageId;
}

export function getConversationRequirementForLeia(experiment, leia) {
  if (!experiment?.stages || !leia?.stageId) return null;
  const dependents = getStagesRequiringConversation(experiment).get(leia.stageId);
  return dependents?.length ? dependents : null;
}

export function getStageProblemLeia(experiment, stage) {
  if (!stage) return null;
  const entries = (experiment?.leias || []).filter((entry) => entry.stageId === stage.id);
  const problemLeiaId =
    stage.orchestration?.problemLeiaId ||
    stage.orchestration?.openingLeiaId ||
    entries[0]?.id;
  return entries.find((entry) => String(entry.id) === String(problemLeiaId)) || entries[0] || null;
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
  if (!experiment?.stages) {
    if (!Array.isArray(experiment?.leias) || experiment.leias.length === 0) {
      throw activityError('Activity requires at least one LEIA');
    }
    return [experiment];
  }
  const positions = new Map(experiment.stages.map(({ id }, index) => [id, index]));
  if (!positions.size || positions.size !== experiment.stages.length ||
      (experiment.leias || []).some(({ stageId }) => !positions.has(stageId))) {
    throw activityError('Invalid activity stages');
  }
  return experiment.stages.map((stage, index) => {
    const number = index + 1;
    const flow = stageExperiment(experiment, stage);
    if (!flow.leias.length) {
      throw activityError(`Stage ${number} requires at least one LEIA`);
    }
    if (flow.leias.some(({ leia }) => !leia?.spec)) {
      throw activityError(`Stage ${number} requires valid LEIAs`);
    }
    const templates = flow.leias.flatMap(({ leia }) => [
      leia.spec.behaviour?.spec?.description || '',
      leia.spec.rubric?.spec?.evaluationPrompt || '',
    ]);
    const references = templates.flatMap((template) => [...template.matchAll(anyReference)]);
    const supportedReferences = templates.flatMap((template) => [...template.matchAll(referencePattern)]);
    if (references.length !== supportedReferences.length) {
      throw activityError(`Stage ${number} contains an unsupported previous stage output`);
    }
    const referencedOutputs = new Set(supportedReferences.map((match) => match[1] || 'problem'));
    if (referencedOutputs.size > 0 && index === 0) {
      throw activityError('The first stage cannot use previous stage references');
    }
    for (const output of STAGE_OUTPUTS) {
      const sourceId = getStageOutputSource(stage, output);
      if (sourceId && !(positions.get(sourceId) < index)) {
        throw activityError(`The source of stage ${number} must be an earlier stage`);
      }
      if (referencedOutputs.has(output) && !sourceId) {
        throw activityError(`Select an earlier stage for ${outputLabels[output]} in stage ${number}`);
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
    for (const entry of flow.leias) {
      if (entry.configuration?.mode === 'transcription' && getStageReferencedOutputs([entry]).size > 0) {
        throw activityError(
          `Stage ${number} cannot use transcription mode because it uses outputs from an earlier stage`
        );
      }
    }
    const validatePreviousStageResource = (config, label) => {
      if (!config) return;
      if (config.enabled && index === 0) {
        throw activityError(`The first stage cannot show a previous stage ${label}`);
      }
      if (
        config.availability !== undefined &&
        !PREVIOUS_STAGE_VIEW_AVAILABILITIES.includes(config.availability)
      ) {
        throw activityError(`Invalid previous ${label} availability in stage ${number}`);
      }
      const prevSourceId = config.sourceStageId ?? null;
      if (prevSourceId && !(positions.get(prevSourceId) < index)) {
        throw activityError(`The previous ${label} source of stage ${number} must be an earlier stage`);
      }
      if (config.enabled && !prevSourceId) {
        throw activityError(`Select an earlier stage for previous ${label} in stage ${number}`);
      }
    };

    validatePreviousStageResource(stage.previousConversation, 'conversation');
    validatePreviousStageResource(stage.previousSubmittedSolution, 'submitted solution');
    if (
      stage.previousConversation?.enabled &&
      stage.previousSubmittedSolution?.enabled &&
      stage.previousConversation.sourceStageId !== stage.previousSubmittedSolution.sourceStageId
    ) {
      throw activityError(
        `Previous conversation and submitted solution must use the same source stage in stage ${number}`
      );
    }
    for (const entry of flow.leias) {
      validatePreviousStageResource(entry.configuration?.previousConversation, 'conversation');
      validatePreviousStageResource(
        entry.configuration?.previousSubmittedSolution,
        'submitted solution'
      );
      if (
        entry.configuration?.previousConversation?.enabled &&
        entry.configuration?.previousSubmittedSolution?.enabled &&
        entry.configuration.previousConversation.sourceStageId !==
          entry.configuration.previousSubmittedSolution.sourceStageId
      ) {
        throw activityError(
          `Previous conversation and submitted solution must use the same source stage in stage ${number}`
        );
      }
    }
    return flow;
  });
}
