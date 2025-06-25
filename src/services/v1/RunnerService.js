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
    return response.data.message;
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
}

export default new RunnerService();
