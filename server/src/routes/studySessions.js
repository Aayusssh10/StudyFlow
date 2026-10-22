import { Router } from 'express';
import {
  listSessions,
  getSummary,
  getSession,
  createSession,
  updateSession,
  deleteSession,
} from '../controllers/studySessionController.js';
import { validateIdParam } from '../utils/validation.js';

const router = Router();

router.get('/', listSessions);
router.get('/summary', getSummary); // must be declared before "/:id"
router.post('/', createSession);
router.get('/:id', validateIdParam(), getSession);
router.put('/:id', validateIdParam(), updateSession);
router.delete('/:id', validateIdParam(), deleteSession);

export default router;
