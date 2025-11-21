import express from 'express';
import {
  generateSpectateToken,
  getSessionForSpectator,
  getLiveSessionsByReplication,
} from '../../controllers/v1/spectatorController.js';
import { authContext } from '../../middlewares/auth.js';
import { requireSpectateToken } from '../../middlewares/spectateAuth.js';

const router = express.Router();

// POST /api/v1/spectator/sessions/:id/token - Generate spectate token
router.post('/sessions/:id/token', authContext, generateSpectateToken);

// GET /api/v1/spectator/sessions/:id - Get session data for spectator (requires spectate token)
router.get('/sessions/:id', requireSpectateToken, getSessionForSpectator);

// GET /api/v1/spectator/replications/:id/sessions - Get live sessions for dashboard
router.get('/replications/:id/sessions', authContext, getLiveSessionsByReplication);

export default router;
