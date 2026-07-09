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
  saveDraft,
  recordDataUsageConsent,
} from '../../controllers/v1/interactionController.js';
import { authContext } from '../../middlewares/auth.js';

const router = Router();

// POST
router.post('/', startSession);
router.post('/test', authContext, startTestSession);
router.post('/:sessionId/messages', sendSessionMessage);
router.post('/:sessionId/data-usage-consent', recordDataUsageConsent);
router.post('/:sessionId/result', saveResultAndFinishSession);
router.post('/:sessionId/finish', finishSession);
router.post('/:sessionId/draft', saveDraft);

// GET
router.get('/:sessionId', getSessionData);
router.get('/:sessionId/solution', getSolution);
router.get('/:sessionId/evaluation', getEvaluation);
export default router;
