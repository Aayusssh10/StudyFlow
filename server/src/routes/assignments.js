import { Router } from 'express';
import {
  listAssignments,
  getAssignment,
  createAssignment,
  updateAssignment,
  updateAssignmentStatus,
  deleteAssignment,
} from '../controllers/assignmentController.js';
import { validateIdParam } from '../utils/validation.js';

const router = Router();

router.get('/', listAssignments);
router.post('/', createAssignment);
router.get('/:id', validateIdParam(), getAssignment);
router.put('/:id', validateIdParam(), updateAssignment);
router.patch('/:id/status', validateIdParam(), updateAssignmentStatus);
router.delete('/:id', validateIdParam(), deleteAssignment);

export default router;
