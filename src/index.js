import express from 'express';
import { createServer } from 'http';
import swaggerUi from 'swagger-ui-express';
import cors from 'cors';
import logger from './utils/logger.js';
import connectDB from './config/db.js';
import errorHandler from './middlewares/errorHandler.js';
import requestLogger from './middlewares/requestLogger.js';
import SwaggerParser from 'swagger-parser';
import managerRoutes from './routes/v1/managerRoutes.js';
import replicationRoutes from './routes/v1/replicationRoutes.js';
import interactionRoutes from './routes/v1/interactionRoutes.js';
import runnerRoutes from './routes/v1/runnerRoutes.js';
import secretRoutes from './routes/v1/secretRoutes.js';
import spectatorRoutes from './routes/v1/spectatorRoutes.js';
import realtimeRoutes from './routes/v1/realtimeRoutes.js';
import providerRoutes from './routes/v1/providerRoutes.js';
import { auth, requireAdvanced } from './middlewares/auth.js';
import { initializeSocket } from './socket/index.js';
import LukeService from './services/v1/LukeService.js';

const app = express();
const httpServer = createServer(app);

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  })
);
app.use(express.json());
app.use(requestLogger);
app.use(auth);
// Swagger
SwaggerParser.bundle('./api/openapi.yaml')
  .then((bundledDoc) => {
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(bundledDoc));
  })
  .catch((error) => {
    console.error('Error bundling OAS file:', error);
  });

// Admin secret
app.use('/api/v1/secret', secretRoutes);

// Routes v1
app.use('/api/v1/manager', requireAdvanced, managerRoutes);
app.use('/api/v1/replications', replicationRoutes);
app.use('/api/v1/interactions', interactionRoutes);
app.use('/api/v1/runner', runnerRoutes);
app.use('/api/v1/spectator', spectatorRoutes);
app.use('/api/v1/realtime', realtimeRoutes);
app.use('/api/v1/provider', providerRoutes);

// Error handling middleware
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    await connectDB();

    httpServer.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
    });

    // Initialize Socket.IO
    initializeSocket(httpServer);

    // Initialize Luke WebSocket server (shares same port via /luke path)
    LukeService.initialize(httpServer);

    const gracefulShutdown = () => {
      logger.info('Shutting down server...');
      httpServer.close(() => {
        logger.info('Server has been shut down');
        process.exit(0);
      });

      setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
  } catch (error) {
    logger.error(`Error starting server: ${error.message}`);
    process.exit(1);
  }
};

startServer();

export default app;
