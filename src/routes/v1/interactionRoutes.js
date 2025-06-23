import { Router } from 'express';
import {
  startSession,
  getSessionData,
  sendSessionMessage,
  saveResultAndFinishSession,
  getEvaluation,
  startTestSession,
  getSolution,
  finishSession,
} from '../../controllers/v1/interactionController.js';
import { admin } from '../../middlewares/auth.js';

const router = Router();

// POST
router.post('/', startSession);
router.post('/test', admin, startTestSession);
router.post('/:sessionId/messages', sendSessionMessage);
router.post('/:sessionId/result', saveResultAndFinishSession);
router.post('/:sessionId/finish', finishSession);

// GET
router.get('/:sessionId', getSessionData);
router.get('/:sessionId/solution', getSolution);
router.get('/:sessionId/evaluation', getEvaluation);

export default router;
