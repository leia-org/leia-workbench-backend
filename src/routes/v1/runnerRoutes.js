import { Router } from 'express';
import { getRunnerModels } from '../../controllers/v1/runnerController.js';
import { authContext } from '../../middlewares/auth.js';

const router = Router();

router.get('/models', authContext, getRunnerModels);

export default router;
