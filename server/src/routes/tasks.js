import { Router } from 'express';
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  updateTaskCompleted,
  deleteTask,
} from '../controllers/taskController.js';
import { validateIdParam } from '../utils/validation.js';

const router = Router();

router.get('/', listTasks);
router.post('/', createTask);
router.get('/:id', validateIdParam(), getTask);
router.put('/:id', validateIdParam(), updateTask);
router.patch('/:id/completed', validateIdParam(), updateTaskCompleted);
router.delete('/:id', validateIdParam(), deleteTask);

export default router;
