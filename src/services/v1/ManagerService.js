import axios from 'axios';

class ManagerService {
  async findAllExperiments() {
    const response = await axios.get(`${process.env.CATALOG_URL}/api/v1/experiments`);
    return response.data;
  }

  async findExperimentById(id) {
    const response = await axios.get(`${process.env.CATALOG_URL}/api/v1/experiments/${id}`);
    return response.data;
  }
}

export default new ManagerService();
