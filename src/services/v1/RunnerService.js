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

  async initializeMultiLeia(sessionId, leias, orchestration) {
    const actors = leias.map((entry) => ({
      id: String(entry.id),
      name:
        entry.leia?.spec?.persona?.spec?.firstName ||
        entry.leia?.spec?.persona?.spec?.fullName ||
        entry.leia?.metadata?.name ||
        String(entry.id),
      leia: entry.leia,
      runnerConfiguration: entry.runnerConfiguration,
    }));
    const response = await axios.post(
      `${process.env.RUNNER_URL}/api/v1/multi-leias`,
      {
        sessionId,
        actors,
        orchestration: {
          maxInternalTurns: orchestration.maxInternalTurns,
          openingActorId: orchestration.openingLeiaId
            ? String(orchestration.openingLeiaId)
            : null,
          problemActorId: orchestration.problemLeiaId
            ? String(orchestration.problemLeiaId)
            : null,
          sharedTask: orchestration.sharedTask || '',
        },
      },
      {
        headers: {
          Authorization: 'Bearer ' + process.env.RUNNER_KEY,
        },
      }
    );
    return response.data;
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

  async sendMultiLeiaMessage(sessionId, message, turnId) {
    const response = await axios.post(
      `${process.env.RUNNER_URL}/api/v1/multi-leias/${sessionId}/messages`,
      { message, turnId },
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

  // Stateless supervisor observation. Returns { flags, nudge }.
  async observeSupervisor({ runnerConfiguration, transcript, supervisorConfig, existingFlags }) {
    const body = { runnerConfiguration, transcript, supervisorConfig };
    if (Array.isArray(existingFlags) && existingFlags.length > 0) {
      body.existingFlags = existingFlags;
    }
    const response = await axios.post(
      `${process.env.RUNNER_URL}/api/v1/supervisor`,
      body,
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
