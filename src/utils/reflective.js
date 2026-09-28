import reflectiveRuntime from './reflectiveRuntime.cjs';

const contextReference = /{{\s*reflectiveContext\.(?:previousConversation|previousSolution)\s*}}/;

export const needsPreviousConversation = (entry) => {
  const spec = { ...entry?.leia?.spec?.behaviour?.spec };
  const dynamics = spec.conversationDynamics || {};
  spec.conversationDynamics = Object.fromEntries(
    Object.entries(dynamics).filter(([, dynamic]) => dynamic?.enabled)
  );
  return contextReference.test(JSON.stringify(spec));
};

export function reflectiveError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function validateReflectiveChain(experiment) {
  const entries = experiment?.leias || [];
  entries.forEach((entry, index) => {
    if (!needsPreviousConversation(entry)) return;
    if (experiment.orchestration?.mode === 'multi') {
      throw reflectiveError('Previous conversation context requires sequential sessions');
    }
    if (index === 0) {
      throw reflectiveError('A LEIA using reflectiveContext must follow another LEIA in the activity');
    }
    if (entry.configuration?.mode === 'transcription') {
      throw reflectiveError('Previous conversation context requires an interactive session');
    }
  });
}

export function getReflectiveSuccessor(replication, session) {
  const entries = replication?.experiment?.leias || [];
  const index = entries.findIndex((entry) => String(entry.id) === String(session.leia));
  return index >= 0 && needsPreviousConversation(entries[index + 1])
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
