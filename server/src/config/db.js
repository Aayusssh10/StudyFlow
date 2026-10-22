import mongoose from 'mongoose';

const CONNECTED = 1; // mongoose.connection.readyState value for "connected"

// Connects to MongoDB. On failure it throws a short, safe error:
// the original error can contain the connection string, so we never pass it on.
export async function connectDB(uri, { timeoutMs = 8000 } = {}) {
  if (!uri) {
    throw new Error('Database URI is not set. Check server/.env (see .env.example).');
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: timeoutMs });
  } catch (error) {
    throw new Error(`Could not connect to MongoDB (${error.name}). Check your URI, database user and Atlas network access.`);
  }
}

export async function disconnectDB() {
  await mongoose.disconnect();
}

export function isDbConnected() {
  return mongoose.connection.readyState === CONNECTED;
}
