import axios from 'axios';
import { StringDecoder } from 'node:string_decoder';

async function consumeSseStream(stream, onEvent) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  const consumeBlock = async (block) => {
    if (!block || block.startsWith(':')) return;
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;

    const rawData = dataLines.join('\n');
    let data;
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }
    await onEvent(event, data);
  };

  for await (const chunk of stream) {
    buffer += decoder.write(chunk).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      await consumeBlock(block);
      boundary = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.end();
  await consumeBlock(buffer.trim());
}

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

  async streamMultiLeiaMessage(sessionId, message, turnId, options = {}) {
    const response = await axios.post(
      `${process.env.RUNNER_URL}/api/v1/multi-leias/${sessionId}/messages/stream`,
      { message, turnId },
      {
        headers: {
          Authorization: 'Bearer ' + process.env.RUNNER_KEY,
          Accept: 'text/event-stream',
        },
        responseType: 'stream',
      }
    );

    let completion = null;
    try {
      await consumeSseStream(response.data, async (event, data) => {
        if (event === 'message' && data?.message) {
          await options.onMessage?.(data.message);
          return;
        }
        if (event === 'route' && data?.nextActorId) {
          await options.onRoute?.(data);
          return;
        }
        if (event === 'complete') {
          completion = data;
          return;
        }
        if (event === 'error') {
          const error = new Error(data?.error || 'MultiLEIA stream failed');
          error.statusCode = data?.statusCode || 500;
          throw error;
        }
      });
    } finally {
      response.data.destroy?.();
    }

    if (!completion) {
      const error = new Error('MultiLEIA stream closed before completion');
      error.statusCode = 502;
      throw error;
    }
    return completion;
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
