import axios from 'axios';

class RunnerService {
  async initializeRunner(sessionId, leia, runnerConfiguration) {
    const response = await axios.post(
      `${process.env.RUNNER_URL}/api/v1/leias`,
      {
        sessionId,
        leia: leia.leia,
        runnerConfiguration: runnerConfiguration || leia.runnerConfiguration,
      },
      {
        headers: {
          Authorization: 'Bearer ' + process.env.RUNNER_KEY,
        },
      }
    );
    return response.data.sessionId;
  }

  async initializeMultiRunner(sessionId, leias, runnerConfiguration) {
    const response = await axios.post(
      `${process.env.RUNNER_URL}/api/v1/multi-leias`,
      {
        sessionId,
        leias: leias.map((leia) => ({
          ...leia.leia,
          id: leia.id,
        })),
        runnerConfiguration,
      },
      {
        headers: {
          Authorization: 'Bearer ' + process.env.RUNNER_KEY,
        },
      }
    );
    return response.data.sessionId;
  }

  async sendMessage(sessionId, message) {
    const response = await axios.post(
      `${process.env.RUNNER_URL}/api/v1/leias/${sessionId}/messages`,
      {
        message,
      },
      {
        headers: {
          Authorization: 'Bearer ' + process.env.RUNNER_KEY,
        },
      }
    );
    return response.data;
  }

  async sendMultiMessage(sessionId, message) {
    const response = await axios.post(
      `${process.env.RUNNER_URL}/api/v1/multi-leias/${sessionId}/messages`,
      {
        message,
      },
      {
        headers: {
          Authorization: 'Bearer ' + process.env.RUNNER_KEY,
        },
      }
    );
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
