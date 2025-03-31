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
  updateReplicationLeiaRunnerConfig,
} from '../../controllers/v1/replicationController.js';

const router = express.Router();

// POST
router.post('/', createReplication);

// PATCH
router.patch('/:id/name', updateReplicationName);
router.patch('/:id/regenerate-code', regenerateReplicationCode);
router.patch('/:id/toggle-active', toggleReplicationIsActive);
router.patch('/:id/duration', updateReplicationDuration);
router.patch('/:id/experiment', updateReplicationExperiment);
router.patch('/:id/leia/:leiaId/runner-config', updateReplicationLeiaRunnerConfig);

// GET
router.get('/', getAllReplications);
router.get('/:id', getReplicationById);

export default router;
