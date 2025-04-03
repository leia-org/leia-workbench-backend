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

  async getEvaluation(result, leia) {
    // const response = await axios.post(
    //   `${process.env.RUNNER_URL}/api/v1/evaluation`,
    //   {
    //     result,
    //     leia,
    //   },
    //   {
    //     headers: {
    //       Authorization: 'Bearer ' + process.env.RUNNER_KEY,
    //     },
    //   }
    // );
    // return response.data;
    return 'Evaluation result';
  }
}

export default new RunnerService();
