import express from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import healthRouter from './routes/health.js';
import subjectsRouter from './routes/subjects.js';
import assignmentsRouter from './routes/assignments.js';
import tasksRouter from './routes/tasks.js';
import studySessionsRouter from './routes/studySessions.js';
import dashboardRouter from './routes/dashboard.js';
import calendarRouter from './routes/calendar.js';
import reportsRouter from './routes/reports.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

// Builds the Express app. Kept separate from server.js so tests can use it
// without opening a real port or connecting to the database.
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({ origin: config.clientOrigin }));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter);
  app.use('/api/subjects', subjectsRouter);
  app.use('/api/assignments', assignmentsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/study-sessions', studySessionsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/calendar', calendarRouter);
  app.use('/api/reports', reportsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
