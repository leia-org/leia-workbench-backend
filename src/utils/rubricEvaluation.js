const CURRENT_STAGE_REF_PATTERN = /{{\s*currentStage\.outputs\.(conversation|submitedSolution)\s*}}/g;

export function hasReferenceSolution(leiaEntry) {
  return Boolean(
    typeof leiaEntry?.leia?.spec?.problem?.spec?.solution === 'string' &&
    leiaEntry.leia.spec.problem.spec.solution.trim()
  );
}

export function hasRubric(leiaEntry) {
  const sections = leiaEntry?.leia?.spec?.rubric?.spec?.sections;
  return Array.isArray(sections) && sections.length > 0;
}

export function resolveEvaluationMode(configuration) {
  if (!configuration) return 'none';
  if (
    configuration.evaluationMode === 'none' ||
    configuration.evaluationMode === 'classic' ||
    configuration.evaluationMode === 'rubric'
  ) {
    return configuration.evaluationMode;
  }
  return configuration.evaluateSolution ? 'classic' : 'none';
}

export function getRubricCurrentStageReferences(leiaEntry) {
  const prompt = leiaEntry?.leia?.spec?.rubric?.spec?.evaluationPrompt || '';
  const outputs = new Set();
  for (const match of prompt.matchAll(CURRENT_STAGE_REF_PATTERN)) {
    outputs.add(match[1]);
  }
  return outputs;
}

export function rubricRequiresSubmittedSolution(leiaEntry) {
  return getRubricCurrentStageReferences(leiaEntry).has('submitedSolution');
}

export function collectRubricCsvColumns(replication, sessions) {
  const sectionMap = new Map();

  const registerSection = (title, weight, criteriaNames) => {
    if (!title) return;
    const existing = sectionMap.get(title) || { title, weight, criteria: [] };
    if (existing.weight == null && weight != null) existing.weight = weight;
    for (const name of criteriaNames || []) {
      if (name && !existing.criteria.includes(name)) {
        existing.criteria.push(name);
      }
    }
    sectionMap.set(title, existing);
  };

  for (const entry of replication?.experiment?.leias || []) {
    const sections = entry?.leia?.spec?.rubric?.spec?.sections || [];
    for (const section of sections) {
      registerSection(
        section.title,
        section.weight,
        (section.criteria || []).map((c) => c.name)
      );
    }
  }

  for (const session of sessions || []) {
    const sections = session?.rubricEvaluation?.sections || [];
    for (const section of sections) {
      registerSection(
        section.title,
        section.weight,
        (section.criteria || []).map((c) => c.name)
      );
    }
  }

  const columns = [];
  for (const section of sectionMap.values()) {
    const weightSuffix = section.weight != null ? ` [${section.weight}%]` : '';
    columns.push({
      type: 'sectionScore',
      sectionTitle: section.title,
      header: `Rubric: ${section.title}${weightSuffix} (Score)`,
    });
    for (const criterionName of section.criteria) {
      columns.push({
        type: 'criterionLevel',
        sectionTitle: section.title,
        criterionName,
        header: `Rubric: ${section.title} - ${criterionName} (Level)`,
      });
      columns.push({
        type: 'criterionScore',
        sectionTitle: section.title,
        criterionName,
        header: `Rubric: ${section.title} - ${criterionName} (Score)`,
      });
    }
  }
  return columns;
}

export function extractRubricCsvValues(rubricEvaluation, columns) {
  if (!columns.length) return [];
  if (!rubricEvaluation?.sections?.length) {
    return columns.map(() => '');
  }
  const sectionByTitle = new Map(
    rubricEvaluation.sections.map((section) => [section.title, section])
  );
  return columns.map((column) => {
    const section = sectionByTitle.get(column.sectionTitle);
    if (!section) return '';
    if (column.type === 'sectionScore') {
      return section.score ?? '';
    }
    const criterion = (section.criteria || []).find((c) => c.name === column.criterionName);
    if (!criterion) return '';
    if (column.type === 'criterionLevel') {
      return criterion.selectedLevel ?? '';
    }
    return criterion.score ?? '';
  });
}
