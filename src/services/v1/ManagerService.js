import axios from 'axios';

class ManagerService {
  async findAllExperiments() {
    const response = await axios.get(`${process.env.CATALOG_URL}/api/v1/experiments`, {
      headers: {
        'x-api-key': process.env.CATALOG_KEY,
      },
    });
    return response.data;
  }

  async findExperimentById(id) {
    const response = await axios.get(`${process.env.CATALOG_URL}/api/v1/experiments/${id}`, {
      headers: {
        'x-api-key': process.env.CATALOG_KEY,
      },
    });
    return response.data;
  }
}

export default new ManagerService();
