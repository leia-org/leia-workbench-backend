import express from 'express';
import { getAllModelsAndDetails } from '../../controllers/v1/providerController.js';
import { requireAdvanced } from '../../middlewares/auth.js';
const router = express.Router();

// GET
router.get('/', requireAdvanced, getAllModelsAndDetails);

export default router;
