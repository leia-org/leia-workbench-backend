import User from '../../models/User.js';

class UserRepository {
  // READ METHODS

  async findAll() {
    return await User.find();
  }

  async findById(id) {
    return await User.findById(id);
  }

  async findByEmail(email) {
    return await User.findOne({ email });
  }

  // WRITE METHODS

  async create(userData) {
    const user = new User(userData);
    return await user.save();
  }
}

export default new UserRepository();
