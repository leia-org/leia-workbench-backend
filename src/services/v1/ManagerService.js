import axios from 'axios';

class ManagerService {
  async findAllMyExperiments(authorization, lastActivityId) {
    const response = await axios.get(`${process.env.MANAGER_URL}/api/v1/experiments/user/me`, {
      headers: {
        'x-api-key': process.env.MANAGER_KEY,
        Authorization: `${authorization}`
      },
      params: {
        lastActivityId: lastActivityId || undefined,
      },
    });
    return response.data;
  }
  async findAllExperiments(lastActivityId) {
    const response = await axios.get(`${process.env.MANAGER_URL}/api/v1/experiments`, {
      headers: {
        'x-api-key': process.env.MANAGER_KEY,
      },
      params: {
        lastActivityId: lastActivityId || undefined,
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
