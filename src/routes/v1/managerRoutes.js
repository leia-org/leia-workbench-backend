import express from 'express';
import { getAllExperiments, getExperimentById } from '../../controllers/v1/managerController.js';
import { requireAdvanced } from '../../middlewares/auth.js';

const router = express.Router();

// GET
router.get('/experiments', requireAdvanced,getAllExperiments);
router.get('/experiments/:id',requireAdvanced, getExperimentById);

export default router;
