import UserRepository from '../../repositories/v1/UserRepository.js';

class UserService {
  // READ METHODS

  async findAll() {
    return await UserRepository.findAll();
  }

  async findById(id) {
    return await UserRepository.findById(id);
  }

  async findByEmail(email) {
    return await UserRepository.findByEmail(email);
  }

  // WRITE METHODS

  async create(userData) {
    return await UserRepository.create(userData);
  }
}

export default new UserService();
