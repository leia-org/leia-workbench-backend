import axios from 'axios';

class RunnerService {
  async initializeRunner(sessionId, leia) {
    const response = await axios.post(
      `${process.env.RUNNER_URL}/api/v1/leias`,
      {
        sessionId,
        leia: leia.leia,
        runnerConfiguration: leia.runnerConfiguration,
      },
      {
        headers: {
          Authorization: 'Bearer ' + process.env.RUNNER_KEY,
        },
      }
    );
    return response.data.sessionId;
  }

  async sendMessage(sessionId, message, options = {}) {
    const body = {};
    if (typeof message === 'string' && message.length > 0) body.message = message;
    if (Array.isArray(options.tools) && options.tools.length > 0) body.tools = options.tools;
    if (Array.isArray(options.toolResults) && options.toolResults.length > 0) body.toolResults = options.toolResults;

    const response = await axios.post(
      `${process.env.RUNNER_URL}/api/v1/leias/${sessionId}/messages`,
      body,
      {
        headers: {
          Authorization: 'Bearer ' + process.env.RUNNER_KEY,
        },
      }
    );
    // Forward the full response shape upward so the caller can branch on
    // toolCalls vs. final text.
    return response.data;
  }

  async getEvaluationAndScore(sessionId, result) {
    const response = await axios.post(
      `${process.env.RUNNER_URL}/api/v1/evaluation`,
      {
        sessionId,
        result,
      },
      {
        headers: {
          Authorization: 'Bearer ' + process.env.RUNNER_KEY,
        },
      }
    );
    const { evaluation, score } = response.data;
    return { evaluation, score };
  }

  async deleteCache(sessionId) {
    const response = await axios.delete(
      `${process.env.RUNNER_URL}/api/v1/cache/purge?sessionId=${sessionId}`,
      {
        headers: {
          Authorization: 'Bearer ' + process.env.RUNNER_KEY,
        },
      }
    );
    return response.data;
  }
    async getRunnerModels() {
    const response = await axios.get(`${process.env.RUNNER_URL}/api/v1/models`, {
      headers: {
        Authorization: 'Bearer ' + process.env.RUNNER_KEY,
      },
    });
    return response.data.models;
  }
}


export default new RunnerService();
