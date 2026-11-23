import axios from 'axios';

class ManagerService {
  async findAccessibleExperiments(authorization, lastActivityId, text, ownedOnly) {
    const response = await axios.get(`${process.env.MANAGER_URL}/api/v1/experiments/accessible`, {
      headers: {
        'x-api-key': process.env.MANAGER_KEY,
        Authorization: `${authorization}`
      },
      params: {
        lastActivityId: lastActivityId || undefined,
        text: text || undefined,
        ownedOnly,
      },
    });
    return response.data;
  }
  async findAllExperiments(lastActivityId, text) {
    const response = await axios.get(`${process.env.MANAGER_URL}/api/v1/experiments`, {
      headers: {
        'x-api-key': process.env.MANAGER_KEY,
      },
      params: {
        lastActivityId: lastActivityId || undefined,
        text: text || undefined,
      },
    });
    return response.data;
  }
  async findExperimentById(id, authorization) {
    const response = await axios.get(`${process.env.MANAGER_URL}/api/v1/experiments/${id}`, {
      headers: {
        'x-api-key': process.env.MANAGER_KEY,
        Authorization: `${authorization}`
      },
    });
    return response.data;
  }
}

export default new ManagerService();
