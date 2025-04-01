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
 * adding the runnerConfiguration and sessionCount properties
 * to each leia in the experiment.
 *
 * @param {object} experiment
 * @returns experiment
 */
export function initializeExperiment(experiment) {
  for (const leia of experiment.leias) {
    leia.runnerConfiguration = {
      provider: 'openai',
    };
    leia.sessionCount = 0;
  }
  return experiment;
}
