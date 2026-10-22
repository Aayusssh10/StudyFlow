import dotenv from 'dotenv';

// Reads server/.env (if it exists) into process.env.
// .env is private and git-ignored; .env.example shows the variable names.
dotenv.config({ quiet: true });

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  // The only website address allowed to call this API from a browser.
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  mongoUri: process.env.MONGODB_URI || '',
  mongoTestUri: process.env.MONGODB_TEST_URI || '',
};

export const isProduction = () => config.nodeEnv === 'production';
