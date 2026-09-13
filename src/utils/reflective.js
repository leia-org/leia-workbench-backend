import reflectiveRuntime from './reflectiveRuntime.cjs';

export const isReflective = (entry) => entry?.leia?.spec?.behaviour?.spec?.reflective === true;

export function reflectiveError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Activity order defines LN -> LR pairs. A reflective LEIA is never a root.
export function validateReflectiveChain(experiment) {
  const entries = experiment?.leias || [];
  entries.forEach((entry, index) => {
    if (!isReflective(entry)) return;
    if (experiment.orchestration?.mode === 'multi') {
      throw reflectiveError('Reflective LEIA requires sequential LN → LR sessions');
    }
    if (index === 0 || isReflective(entries[index - 1])) {
      throw reflectiveError('Each Reflective LEIA must immediately follow a normal LEIA');
    }
    if (entry.configuration?.mode === 'transcription') {
      throw reflectiveError('Reflective LEIA requires an interactive session');
    }
    const spec = entry.leia.spec.behaviour.spec;
    if (!spec.evaluationPrompt?.trim() || !spec.stoppingPrompt?.trim()) {
      throw reflectiveError('Reflective LEIA requires evaluationPrompt and stoppingPrompt');
    }
  });
}

export function getReflectiveSuccessor(replication, session) {
  if (!replication?.reflectiveEnabled || session.previousSession) return null;
  const entries = replication.experiment?.leias || [];
  const index = entries.findIndex((entry) => String(entry.id) === String(session.leia));
  return index >= 0 && !isReflective(entries[index]) && isReflective(entries[index + 1])
    ? entries[index + 1] : null;
}

// Pipes and filters: context is enriched first, then frozen before instantiation.
export function meteConversacion(context, messages) {
  return { ...context, previousConversation: messages.map((message) => ({
    role: message.isLeia ? 'assistant' : 'user', content: message.text,
  })) };
}

export function meteSolucion(context, session) {
  return { ...context, previousSolution: session.result ?? '' };
}

export async function buildReflectiveContext(source, filters = [
  (context) => meteConversacion(context, source.messages),
  (context) => meteSolucion(context, source.session),
]) {
  let context = {};
  for (const enrich of filters) context = await enrich(context);
  return reflectiveRuntime.deepFreeze(context);
}
