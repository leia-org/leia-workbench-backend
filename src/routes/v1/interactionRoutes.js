import { Router } from 'express';
import { requireTestRunsPreview } from '../../config/testRuns.js';
import {
  startSession,
  getSessionData,
  sendSessionMessage,
  streamSessionMessage,
  saveResultAndFinishSession,
  getEvaluation,
  startTestSession,
  getSolution,
  finishSession,
  saveDraft,
  getConversationDynamics,
  continueStage,
  createTestRun,
  getPreviousStageConversation,
  getPreviousStageSubmittedSolution,
  recordDataUsageConsent,
  recordEvents,
} from '../../controllers/v1/interactionController.js';
import { authContext } from '../../middlewares/auth.js';
import { requireInteractionEvents } from '../../config/features.js';

const router = Router();

// POST
router.post('/', startSession);
router.post('/test', authContext, startTestSession);
router.post('/:sessionId/data-usage-consent', recordDataUsageConsent);
router.post('/:sessionId/messages', sendSessionMessage);
router.post('/:sessionId/messages/stream', streamSessionMessage);
router.post('/:sessionId/result', saveResultAndFinishSession);
router.post('/:sessionId/finish', finishSession);
router.post('/:sessionId/next-stage', continueStage);
router.post('/:sessionId/draft', saveDraft);
router.post('/:sessionId/test-runs', requireTestRunsPreview, createTestRun);
router.post('/:sessionId/events', requireInteractionEvents, recordEvents);

// GET
router.get('/:sessionId', getSessionData);
router.get('/:sessionId/conversation-dynamics', getConversationDynamics);
router.get('/:sessionId/solution', getSolution);
router.get('/:sessionId/evaluation', getEvaluation);
router.get('/:sessionId/previous-conversation', getPreviousStageConversation);
router.get('/:sessionId/previous-submitted-solution', getPreviousStageSubmittedSolution);
export default router;
