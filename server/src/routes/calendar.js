import { Router } from 'express';
import { getCalendar } from '../controllers/calendarController.js';

const router = Router();

router.get('/', getCalendar);

export default router;
