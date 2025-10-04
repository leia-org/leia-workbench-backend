import { Server } from 'socket.io';
import logger from '../utils/logger.js';
import jwt from 'jsonwebtoken';

let io = null;

export function initializeSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Middleware for authentication
  io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;

    if (!token) {
      return next(new Error('Authentication token required'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      socket.userRole = decoded.role;
      socket.tokenType = decoded.type || 'regular';
      next();
    } catch (error) {
      logger.error('Socket authentication error:', error);
      next(new Error('Invalid authentication token'));
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}, userId: ${socket.userId}, type: ${socket.tokenType}`);

    // Join session room for spectating
    socket.on('spectate:join', (sessionId) => {
      socket.join(`session:${sessionId}`);
      logger.info(`Socket ${socket.id} joined session room: ${sessionId}`);
      socket.emit('spectate:joined', { sessionId });
    });

    // Leave session room
    socket.on('spectate:leave', (sessionId) => {
      socket.leave(`session:${sessionId}`);
      logger.info(`Socket ${socket.id} left session room: ${sessionId}`);
    });

    // Join replication room for dashboard
    socket.on('dashboard:join', (replicationId) => {
      socket.join(`replication:${replicationId}`);
      logger.info(`Socket ${socket.id} joined replication room: ${replicationId}`);
      socket.emit('dashboard:joined', { replicationId });
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
