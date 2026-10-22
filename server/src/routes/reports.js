import { Router } from 'express';
import { exportCsv, getSummary } from '../controllers/reportController.js';

const router = Router();

router.get('/summary', getSummary);
router.get('/export', exportCsv);

export default router;
