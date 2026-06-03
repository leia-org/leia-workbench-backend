import { Server } from 'socket.io';
import logger from '../utils/logger.js';
import SpectatorService from '../services/v1/SpectatorService.js';
import ReplicationService from '../services/v1/ReplicationService.js';
import { verifyToken } from '../utils/jwt.js';

let io = null;

export function initializeSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  const buildAuthContext = (socket) => {
    const auth = socket.handshake.auth || {};

    const potentialAdminSecret = auth.adminSecret;
    if (typeof potentialAdminSecret === 'string' && potentialAdminSecret === process.env.ADMIN_SECRET) {
      return { isAdmin: true };
    }

    const potentialJwt = typeof auth.jwt === 'string' && auth.jwt.split('.').length === 3 ? auth.jwt : null;
    if (potentialJwt) {
      try {
        const decoded = SpectatorService.verifySpectateToken(potentialJwt);
        return {
          isAdmin: false,
          spectate: {
            sessionId: decoded.sessionId,
            replicationId: decoded.replicationId,
          },
        };
      } catch (error) {
        throw new Error(error.message || 'Invalid authentication token');
      }
    }

    // User JWT issued by the auth service — the frontend sends it as auth.token.
    // An admin gets full dashboard/spectate access; this replaces the legacy
    // adminSecret after the auth migration. Falls through to share-token
    // handling if it isn't a valid user JWT.
    const potentialUserJwt =
      typeof auth.token === 'string' && auth.token.split('.').length === 3 ? auth.token : null;
    if (potentialUserJwt) {
      try {
        const decoded = verifyToken(potentialUserJwt);
        if (decoded?.role === 'admin') {
          return { isAdmin: true, userId: decoded.id, role: decoded.role };
        }
      } catch {
        // Not a valid user JWT — fall through to share-token handling below.
      }
    }

    const shareToken = auth.shareToken || (typeof auth.token === 'string' ? auth.token : null);
    if (shareToken) {
      return {
        isAdmin: false,
        shareToken,
      };
    }

    const error = new Error('Authorization required: admin secret, share token, or spectate token');
    error.statusCode = 401;
    throw error;
  };

  // Middleware for authentication
  io.use((socket, next) => {
    try {
      socket.user = buildAuthContext(socket);
      next();
    } catch (error) {
      logger.error('Socket authentication error:', error);
      next(error);
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);

    // Join session room for spectating
    socket.on('spectate:join', async (sessionId) => {
      try {
        if (!sessionId) {
          throw new Error('Session ID is required');
        }

        if (socket.user?.spectate) {
          if (socket.user.spectate.sessionId !== sessionId) {
            throw new Error('Spectate token does not match the requested session');
          }
        } else if (!socket.user?.isAdmin) {
          throw new Error('Spectate access denied');
        }

        socket.join(`session:${sessionId}`);
        logger.info(`Socket ${socket.id} joined session room: ${sessionId}`);
        socket.emit('spectate:joined', { sessionId });
      } catch (error) {
        logger.warn(`Spectate join denied for ${socket.id}: ${error.message}`);
        socket.emit('spectate:error', { message: error.message });
      }
    });

    // Leave session room
    socket.on('spectate:leave', (sessionId) => {
      socket.leave(`session:${sessionId}`);
      logger.info(`Socket ${socket.id} left session room: ${sessionId}`);
    });

    // Join replication room for dashboard
    socket.on('dashboard:join', async (replicationId) => {
      try {
        if (!replicationId) {
          throw new Error('Replication ID is required');
        }

        await ReplicationService.checkAccess(replicationId, Boolean(socket.user?.isAdmin), socket.user?.shareToken);

        socket.join(`replication:${replicationId}`);
        logger.info(`Socket ${socket.id} joined replication room: ${replicationId}`);
        socket.emit('dashboard:joined', { replicationId });
      } catch (error) {
        logger.warn(`Dashboard join denied for ${socket.id}: ${error.message}`);
        socket.emit('dashboard:error', { message: error.message });
      }
    });

    // Leave replication room
    socket.on('dashboard:leave', (replicationId) => {
      socket.leave(`replication:${replicationId}`);
      logger.info(`Socket ${socket.id} left replication room: ${replicationId}`);
    });

    // User typing event
    socket.on('session:typing', ({ sessionId, isTyping }) => {
      socket.to(`session:${sessionId}`).emit('user:typing', {
        sessionId,
        isTyping,
        userId: socket.userId,
      });
    });

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });

    socket.on('error', (error) => {
      logger.error(`Socket error for ${socket.id}:`, error);
    });
  });

  logger.info('Socket.IO initialized');
  return io;
}

// Helper function to emit events
export function emitToSession(sessionId, event, data) {
  if (!io) {
    logger.warn('Socket.IO not initialized, cannot emit event');
    return;
  }
  io.to(`session:${sessionId}`).emit(event, data);
}

export function emitToReplication(replicationId, event, data) {
  if (!io) {
    logger.warn('Socket.IO not initialized, cannot emit event');
    return;
  }
  io.to(`replication:${replicationId}`).emit(event, data);
}

export function getIO() {
  if (!io) {
    throw new Error('Socket.IO not initialized');
  }
  return io;
}

export default { initializeSocket, emitToSession, emitToReplication, getIO };
