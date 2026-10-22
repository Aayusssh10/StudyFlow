import { config } from './config/env.js';
import { connectDB } from './config/db.js';
import { createApp } from './app.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`StudyFlow API listening on http://localhost:${config.port}`);
});

// The API starts even if the database is unreachable, so /api/health can
// report the problem. The connection string is never printed.
connectDB(config.mongoUri)
  .then(() => console.log('MongoDB connected.'))
  .catch((error) => console.error(`MongoDB NOT connected: ${error.message}`));
