import { Router } from 'express';
import {
  listSubjects,
  getSubject,
  createSubject,
  updateSubject,
  deleteSubject,
} from '../controllers/subjectController.js';
import { validateIdParam } from '../utils/validation.js';

const router = Router();

router.get('/', listSubjects);
router.post('/', createSubject);
router.get('/:id', validateIdParam(), getSubject);
router.put('/:id', validateIdParam(), updateSubject);
router.delete('/:id', validateIdParam(), deleteSubject);

export default router;
