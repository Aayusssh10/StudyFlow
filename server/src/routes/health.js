import { Router } from 'express';
import { isDbConnected } from '../config/db.js';

const router = Router();

// "server" is always "up" if you can read this response.
// "database" is reported separately, so you can tell apart
// "the API is running" from "the API can reach MongoDB".
router.get('/', (req, res) => {
  const database = isDbConnected() ? 'connected' : 'disconnected';
  res.json({
    success: true,
    data: {
      server: 'up',
      database,
      status: database === 'connected' ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
    },
  });
});

export default router;
