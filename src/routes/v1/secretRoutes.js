import express from 'express';
import { checkSecret } from '../../controllers/v1/secretController.js';

const router = express.Router();

router.post('/', checkSecret);

export default router;
