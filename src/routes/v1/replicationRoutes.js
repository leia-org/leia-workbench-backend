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
} from '../../controllers/v1/replicationController.js';

const router = express.Router();

// POST
router.post('/', createReplication);

// PATCH
router.patch('/:id/name', updateReplicationName);
router.patch('/:id/regenerate-code', regenerateReplicationCode);
router.patch('/:id/toggle-active', toggleReplicationIsActive);
router.patch('/:id/toggle-repeatable', toggleReplicationIsRepeatable);
router.patch('/:id/leia/:leiaId/toggle-ask-solution', toggleAskSolution);
router.patch('/:id/leia/:leiaId/toggle-evaluate-solution', toggleEvaluateSolution);
router.patch('/:id/duration', updateReplicationDuration);
router.patch('/:id/experiment', updateReplicationExperiment);
router.patch('/:id/form', updateReplicationForm);
router.patch('/:id/leia/:leiaId/runner-configuration', updateReplicationLeiaRunnerConfiguration);

// GET
router.get('/', getAllReplications);
router.get('/:id', getReplicationById);

// DELETE
router.delete('/:id/form', deleteReplicationForm);

export default router;
