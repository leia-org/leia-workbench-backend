/**
 * Generate a unique code for an mongoose model
 *
 * @param {Model} model
 * @param {string} prefix
 * @param {number} maxAttempts
 * @returns {Promise<string>}
 * @throws {Error} - Error generating unique code: maximum number of attempts reached
 */
export async function generateUniqueCode(model, prefix, maxAttempts = 5) {
  let code;
  let exists = true;
  let attempts = 0;

  while (exists && attempts < maxAttempts) {
    code = String(prefix) + (Date.now().toString(36) + Math.random().toString(36).substring(2, 10)).toUpperCase();
    exists = await model.exists({ code });
    attempts++;
  }

  if (exists) {
    throw new Error('Error generating unique code: maximum number of attempts reached');
  }

  return code;
}
/**
 * Initialize the experiment object to save it in the database,
 * adding runner configuration and session state for the replication.
 *
 * @param {object} experiment
 * @returns experiment
 */
export function initializeExperiment(experiment) {
  if (experiment.isMultiLeia) {
    experiment.globalConfiguration = experiment.globalConfiguration || {
      runner: {
        provider: 'default',
      },
      askSolution: true,
      evaluateSolution: true,
    };
  }

  for (const leia of experiment.leias) {
    leia.runnerConfiguration = {
      provider: 'default',
      audioMode: null,
      hideAudioTranscription: null,
    };
    leia.sessionCount = 0;
    leia.configuration.askSolution = true;
    leia.configuration.evaluateSolution = true;
  }
  return experiment;
}
