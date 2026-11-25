import { Server } from 'socket.io';
import { createFrontendOriginHandler } from '../utils/frontendOrigins.js';
import logger from '../utils/logger.js';
import SpectatorService from '../services/v1/SpectatorService.js';
import ReplicationService from '../services/v1/ReplicationService.js';
import SessionRepository from '../repositories/v1/SessionRepository.js';
import { verifyToken } from '../utils/jwt.js';
import { ownsReplication } from '../utils/replicationOwnership.js';

let io = null;

export function initializeSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: createFrontendOriginHandler((process.env.FRONTEND_URL || '').split(',')),
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
            runId: decoded.runId || null,
          },
        };
      } catch (error) {
        throw new Error(error.message || 'Invalid authentication token');
      }
    }

    // User JWT issued by the auth service — the frontend sends it as auth.token.
    // Admins get full dashboard/spectate access; authenticated owners (e.g.
    // advanced users) are checked against replication ownership on room join.
    // Falls through to share-token handling if it isn't a valid user JWT.
    const explicitShareToken =
      typeof auth.shareToken === 'string' && auth.shareToken ? auth.shareToken : null;
    const potentialUserJwt =
      typeof auth.token === 'string' && auth.token.split('.').length === 3 ? auth.token : null;
    if (potentialUserJwt) {
      try {
        const decoded = verifyToken(potentialUserJwt);
        if (decoded?.role === 'admin') {
          return {
            isAdmin: true,
            id: decoded.id,
            userId: decoded.id,
            role: decoded.role,
            ...(explicitShareToken ? { shareToken: explicitShareToken } : {}),
          };
        }
        if (decoded?.id) {
          return {
            isAdmin: false,
            id: decoded.id,
            userId: decoded.id,
            role: decoded.role,
            ...(explicitShareToken ? { shareToken: explicitShareToken } : {}),
          };
        }
      } catch {
        // Not a valid user JWT — fall through to share-token handling below.
      }
    }

    const shareToken = explicitShareToken || (typeof auth.token === 'string' ? auth.token : null);
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
          const authorized = await SpectatorService.isSessionAuthorizedForSpectateToken(sessionId, {
            spectateSession: socket.user.spectate.sessionId,
            spectateRun: socket.user.spectate.runId,
          });
          if (!authorized) {
            throw new Error('Spectate token does not match the requested session');
          }
        } else if (!socket.user?.isAdmin) {
          let authorizedOwner = false;
          if (socket.user?.id) {
            const session = await SessionRepository.findById(sessionId);
            if (session?.replication) {
              const replication = await ReplicationService.findById(session.replication.toString());
              authorizedOwner = Boolean(replication && ownsReplication(replication, socket.user));
            }
          }
          if (!authorizedOwner) {
            throw new Error('Spectate access denied');
          }
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

        let canManageReplication = Boolean(socket.user?.isAdmin);
        if (!canManageReplication && socket.user?.id) {
          const replication = await ReplicationService.findById(replicationId);
          if (!replication) {
            throw new Error('Replication not found');
          }
          canManageReplication = ownsReplication(replication, socket.user);
        }

        await ReplicationService.checkAccess(replicationId, canManageReplication, socket.user?.shareToken);

        if (canManageReplication) {
          if (!socket.managedReplications) {
            socket.managedReplications = new Set();
          }
          socket.managedReplications.add(String(replicationId));
        }

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
      socket.managedReplications?.delete(String(replicationId));
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

// Like emitToReplication but only to sockets authorized to manage the
// replication (admins and owning advanced users). Used for instructor-only
// data (e.g. supervisor flags) that share-token dashboard viewers must not
// receive.
export function emitToReplicationAdmins(replicationId, event, data) {
  if (!io) {
    logger.warn('Socket.IO not initialized, cannot emit event');
    return;
  }
  const room = io.sockets.adapter.rooms.get(`replication:${replicationId}`);
  if (!room) return;
  const replicationKey = String(replicationId);
  for (const socketId of room) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket?.user?.isAdmin || socket?.managedReplications?.has(replicationKey)) {
      socket.emit(event, data);
    }
  }
}

export function getIO() {
  if (!io) {
    throw new Error('Socket.IO not initialized');
  }
  return io;
}

export default { initializeSocket, emitToSession, emitToReplication, getIO };
