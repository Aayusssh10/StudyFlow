import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The browser talks to Vite (port 5173). Any request that starts with /api is forwarded
// to the Express server, so the client code can simply call "/api/..." and never needs to
// know the server address. API_PROXY_TARGET lets the automated browser tests (e2e/)
// point the same client at a separate test server; normally you do not set it.
const apiTarget = process.env.API_PROXY_TARGET || 'http://localhost:5000'
const proxy = { '/api': apiTarget }

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { proxy },
})
