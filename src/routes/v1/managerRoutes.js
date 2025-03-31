import express from 'express';
import { getAllExperiments, getExperimentById } from '../../controllers/v1/managerController.js';

const router = express.Router();

// GET
router.get('/experiments', getAllExperiments);
router.get('/experiments/:id', getExperimentById);

export default router;
