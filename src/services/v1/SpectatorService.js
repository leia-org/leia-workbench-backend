import jwt from 'jsonwebtoken';
import SessionRepository from '../../repositories/v1/SessionRepository.js';

class SpectatorService {
  /**
   * Generate spectate token for a session
   * @param {string} sessionId - Session ID
   * @param {number} expiresIn - Expiration time in seconds (default 3600 = 1 hour)
   * @returns {Promise<{token: string, expiresAt: Date}>}
   */
  async generateSpectateToken(sessionId, expiresIn = 3600) {
    // Verify session exists
    const session = await SessionRepository.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    const payload = {
      sessionId,
      type: 'spectate',
      replicationId: session.replication.toString(),
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn,
    });

    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    return {
      token,
      expiresAt,
      sessionId,
    };
  }

  /**
   * Verify spectate token
   * @param {string} token - JWT token
   * @returns {Object} Decoded token payload
   */
  verifySpectateToken(token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.type !== 'spectate') {
        const error = new Error('Invalid token type');
        error.statusCode = 403;
        throw error;
      }

      return decoded;
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        const err = new Error('Spectate token has expired');
        err.statusCode = 403;
        throw err;
      }
      const err = new Error('Invalid spectate token');
      err.statusCode = 403;
      throw err;
    }
  }

  /**
   * Generate spectate URL
   * @param {string} sessionId - Session ID
   * @param {string} token - Spectate token
   * @returns {string} Full spectate URL
   */
  generateSpectateUrl(sessionId, token) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return `${frontendUrl}/spectate/${sessionId}?token=${token}`;
  }
}

export default new SpectatorService();
