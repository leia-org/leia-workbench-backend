import express from 'express';
import {
  createReplication,
  getReplicationById,
  getAllReplications,
  updateReplicationName,
  regenerateReplicationCode,
  toggleReplicationIsActive,
  updateReplicationDuration,
  updateReplicationExperiment,
  updateReplicationLeiaRunnerConfiguration,
  toggleReplicationIsRepeatable,
  updateReplicationForm,
  deleteReplicationForm,
  toggleAskSolution,
  toggleEvaluateSolution,
  getReplicationConversations,
  downloadReplicationConversationsCSV,
  updateSessionScore,
  regenerateReplicationShareToken,
  toggleReplicationIsShared,
  replicationNameExists
} from '../../controllers/v1/replicationController.js';
import { authContext, requireAdvanced } from '../../middlewares/auth.js';

const router = express.Router();

// POST
router.post('/', requireAdvanced, createReplication);

// PATCH
router.patch('/:id/name', requireAdvanced, updateReplicationName);
router.patch('/:id/regenerate-code', authContext, regenerateReplicationCode);
router.patch('/:id/regenerate-share-token', requireAdvanced, regenerateReplicationShareToken);
router.patch('/:id/toggle-active', authContext, toggleReplicationIsActive);
router.patch('/:id/toggle-repeatable', authContext, toggleReplicationIsRepeatable);
router.patch('/:id/toggle-shared', requireAdvanced, toggleReplicationIsShared);
router.patch('/:id/leia/:leiaId/toggle-ask-solution', authContext, toggleAskSolution);
router.patch('/:id/leia/:leiaId/toggle-evaluate-solution', authContext, toggleEvaluateSolution);
router.patch('/:id/duration', authContext, updateReplicationDuration);
router.patch('/:id/experiment', authContext, updateReplicationExperiment);
router.patch('/:id/form', authContext, updateReplicationForm);
router.patch('/:id/leia/:leiaId/runner-configuration', authContext, updateReplicationLeiaRunnerConfiguration);
router.patch('/:id/sessions/:sessionId/score', authContext, updateSessionScore);
// GET
router.get('/', requireAdvanced, getAllReplications);
router.get('/:id/conversations', authContext, getReplicationConversations);
router.get('/:id/conversations/csv', authContext, downloadReplicationConversationsCSV);
router.get('/:id', authContext, getReplicationById);
router.get('/exists/:name', requireAdvanced, replicationNameExists);
// DELETE
router.delete('/:id/form', authContext, deleteReplicationForm);

export default router;
