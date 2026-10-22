# StudyFlow website (client)

The React + Vite front end of StudyFlow. **Setup, commands, the API and troubleshooting are in the
[main README](../README.md)**; start there.

From the project folder (one level up):

```bash
npm run dev:client   # development server on http://localhost:5173 (needs the API running: npm run dev:server)
npm run build        # production build into client/dist
npm run lint         # Oxlint
```

## Where things are

- `src/pages/`: one file per page (`/`, `/subjects`, `/assignments`, `/tasks`, `/calendar`, `/study-sessions`, `/reports`, `/settings`)
- `src/components/`: shared pieces (layout, forms, cards, dialogs, charts)
- `src/api/`: every call to the server lives here; `client.js` handles the response format and errors
- `src/utils/`: date helpers (dates are plain `YYYY-MM-DD` text, never converted through UTC), calendar and report helpers, settings storage
- `src/hooks/`: small React hooks
- `src/styles/global.css`: the whole design system (colours are variables at the top)

The website has no environment variables. In development, Vite forwards every `/api/...` request to the API on
`http://localhost:5000` (set `API_PROXY_TARGET` to use another address), so the browser never needs the API's address.
