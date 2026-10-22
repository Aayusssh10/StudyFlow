# StudyFlow browser tests

These tests drive a **real Chrome** (headless) through the app, the way a user would.

```
npm run test:e2e                 # from the project root: every spec
npm run test:e2e -- assignments  # only specs whose file name contains "assignments"
```

## What happens when you run them
1. The client is built **in production mode** (the runner forces `NODE_ENV=production`, because loading `server/.env` would
   otherwise make it a development build), and served with `vite preview` on port **5175**.
2. A separate copy of the API starts on port **5001**. It refuses to start unless it is connected to
   the database named **`studyflow_test`** (`MONGODB_TEST_URI` in `server/.env`).
3. Each spec in `specs/` runs in Chrome. Test data is tagged with a unique prefix (`zz_test_xxxxxxxx_`).
4. After each spec, **only the records carrying that tag are deleted**. Your real `studyflow` data is never touched.
5. If `studyflow_test` already holds data that the tests did not create, the run stops instead of deleting it.

## The specs
| Spec | Covers |
|---|---|
| `subjects`, `assignments`, `tasks`, `sessions` | Each page's create / edit / delete / filter / validation behaviour, empty, loading and error states |
| `dashboard`, `calendar`, `reports`, `settings` | Figures checked against hand-calculated values and the database, charts, links, CSV exports, week start and formats, time zones |
| `quality` | Accessibility scans with axe-core (WCAG A/AA + best practice) on every page and state, page titles and focus, keyboard use, widths 320 / 375 / 768 / 1280 px, loading / error / unreachable states, no console output, no secrets in the delivered code |
| `workflow` | One student journey through the UI, from an empty dashboard to everything deleted again |

## Needs
- Google Chrome or Microsoft Edge installed (set `CHROME_PATH` to use another Chromium browser).
- `npm run install:all` once (installs `playwright-core` and `axe-core`, small libraries; it does **not** download a browser).
- Run these tests and the backend tests **one after the other**, never together: they share the `studyflow_test` database.
- `MONGODB_TEST_URI` set in `server/.env`.

## Reading the result
- `PASS` / `FAIL` per step, then a summary.
- **Unexpected browser errors** (console errors, HTTP 4xx/5xx, failed requests) fail the run, except those a step
  provokes on purpose (marked `provoked`, e.g. a duplicate name giving HTTP 409).
- A cancelled `GET` (the browser abandoning a read when you navigate away) is counted separately as harmless.
  A cancelled or failed `POST`/`PUT`/`PATCH`/`DELETE` is never allowed.
- Screenshots are saved to `e2e/screenshots/` (git-ignored).

## Adding a spec
Create `specs/<name>.spec.mjs` that exports `name` and a default `async function (t)`; use `t.step(...)`,
`t.newPage()`, `t.api(...)` and `t.N('label')` (a tagged name). See `specs/subjects.spec.mjs`.
