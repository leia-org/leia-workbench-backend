import axios from 'axios';

class ManagerService {
  async findAllExperiments() {
    const response = await axios.get(`${process.env.MANAGER_URL}/api/v1/experiments`, {
      headers: {
        'x-api-key': process.env.MANAGER_KEY,
      },
    });
    return response.data;
  }

  async findExperimentById(id, authorization) {
    const response = await axios.get(`${process.env.MANAGER_URL}/api/v1/experiments/${id}`, {
      headers: {
        Authorization: authorization,
      },
    });
    return response.data;
  }
}

export default new ManagerService();
