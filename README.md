# StudyFlow: Student Planner

StudyFlow is a web app for students. It keeps your **subjects**, **assignments**, **daily tasks** and **study sessions**
in one place, and shows them on a **dashboard**, a **calendar** and **reports** that are always calculated from your saved data.

> **Local demo app.** There is no login and no per-user data: everyone who can reach the server sees and changes the
> same data. Do not put private information in it, and do not expose it to the internet. It is **not** a secure
> multi-user production application.

**Contents:** [Features](#features) · [Technologies](#technologies) · [Folder structure](#folder-structure) ·
[Prerequisites](#prerequisites) · [Quick start](#quick-start) · [Setting up the database](#setting-up-the-database-mongodb-atlas) ·
[Environment variables](#environment-variables) · [Commands](#commands) · [Production-style run](#production-style-run) ·
[How it works](#how-it-works-the-rules) · [API](#api) · [Testing](#testing) · [Troubleshooting](#troubleshooting) ·
[Limitations](#known-limitations) · [Next steps](#suggested-next-steps)

---

## Features

| Page | What you can do |
|---|---|
| **Dashboard** (`/`) | See subjects, pending, overdue and due-soon assignments, today's tasks, study time (today and this week), upcoming deadlines, a 7-day study chart, an assignment-status chart and recent activity. A welcome message guides a new user. Every figure links to the matching page. |
| **Subjects** (`/subjects`) | Create, edit and delete subjects (name, optional code, instructor, description, colour). Names are unique. A subject that is still in use cannot be deleted. |
| **Assignments** (`/assignments`) | Create, edit, complete and delete assignments with subject, due date and time, priority, status, estimate and type. Search by title; filter by subject, status, priority, deadline state and due-date range; sort by due date, priority or date added. Overdue, due-soon, upcoming and completed are shown with colour **and** text. |
| **Daily tasks** (`/tasks`) | A day planner (previous, next, pick a day) plus Overdue, Upcoming and All views. Tick tasks off, edit and delete them, and optionally link a task to a subject **or** an assignment. |
| **Calendar** (`/calendar`) | Month and week views of assignment deadlines, tasks and study sessions. Hide kinds you do not want, filter by subject, open any event for details, and jump to its record. Study sessions are labelled *planned* or *recorded*. |
| **Study sessions** (`/study-sessions`) | Record time spent on a subject (whole minutes, optional start time, linked assignment, type and notes). Totals for today, this week and the current filter are calculated from the saved sessions, with a breakdown by subject. |
| **Reports** (`/reports`) | Choose a period (this week, last 7 or 30 days, this month, all time, custom) and a subject. See assignment and task completion rates, pending and overdue counts, study time by day or week and by subject, and the assignment status mix. **Export to CSV** (assignments, tasks or study sessions). |
| **Settings** (`/settings`) | Week start (Monday or Sunday), date format and time format. Saved in your browser only. |

Also: a sidebar that shows whether the server **and** the database are reachable, loading / error / empty states on every
page, confirmation before deleting, keyboard navigation with visible focus, and layouts that work from phone to desktop width.

## Technologies

| Part | Technology |
|---|---|
| Frontend | React 19, Vite 8, React Router 7, Recharts 3 (charts, loaded only when a chart is shown). Plain JavaScript and CSS. |
| Backend | Node.js, Express 5, Mongoose 9 (REST API, JSON) |
| Database | MongoDB. Verified on MongoDB Atlas (free M0 tier, MongoDB 8.0.34, a replica set) |
| Tests | Node's built-in test runner (backend), Playwright core driving a real Chrome (browser tests), axe-core (accessibility scans) |
| Quality | Oxlint (lint), Vite production build |

## Folder structure

```
StudyFlow/
├── README.md                 this file
├── package.json              shortcut commands that run the three parts below (npm run ... from this folder)
├── docs/architecture-notes.md   technical notes: data integrity, behaviours, limitations, testing notes
├── server/                   the API
│   ├── .env.example          copy to .env (see "Environment variables"); .env itself is private
│   ├── src/
│   │   ├── server.js, app.js     start-up and the Express app
│   │   ├── config/               environment variables, database connection
│   │   ├── routes/               URL → controller
│   │   ├── controllers/          what each endpoint does
│   │   ├── validators/           checks every input (body and query string)
│   │   ├── models/               Mongoose models: Subject, Assignment, Task, StudySession
│   │   ├── middleware/           error handling (one consistent JSON error format)
│   │   └── utils/                dates, timing rules, transactions, CSV, study summaries
│   ├── scripts/check-integrity.js   read-only checker for broken links between records
│   └── tests/                backend tests
├── client/                   the website
│   ├── index.html, vite.config.js
│   └── src/ pages/, components/, api/ (all calls to the server), hooks/, utils/, constants/, styles/
└── e2e/                      browser tests (see e2e/README.md)
    ├── run.mjs, lib/, specs/
```

## Prerequisites

- **Node.js 20.19 or newer** (22.12 or newer also works). Tested with Node 24.20.0 and npm 11.19.0. Check with `node -v`.
- **A MongoDB database that is a *replica set*.** The free **MongoDB Atlas** tier is one, and is what this guide uses.
  A plain local MongoDB (a "standalone" server) will **not** work, because StudyFlow uses transactions; see
  [Setting up the database](#setting-up-the-database-mongodb-atlas).
- **Google Chrome or Microsoft Edge**, only if you want to run the browser tests.
- A terminal (PowerShell, Command Prompt, macOS Terminal or a Linux shell). All commands below are the same on every system
  except where noted.

## Quick start

Open a terminal **in the StudyFlow folder** (the one that contains this README) and follow these steps.

**1. Install everything** (once):

```bash
npm run install:all
```

**2. Create your database** on MongoDB Atlas and copy its connection address. This is the longest step, and it is explained
step by step in the next section. You never type this address into the code or into a chat.

**3. Create the private settings file.** Copy the example and then edit the copy:

```bash
# Windows (Command Prompt or PowerShell)
copy server\.env.example server\.env

# macOS / Linux
cp server/.env.example server/.env
```

Open `server/.env` in a text editor and replace the placeholders with your own values (see
[Environment variables](#environment-variables)). Never share this file or commit it to Git; it is already git-ignored.

**4. Start the API** (first terminal):

```bash
npm run dev:server
```

You should see `StudyFlow API listening on http://localhost:5000` and then `MongoDB connected.`

**5. Start the website** (second terminal, same folder):

```bash
npm run dev:client
```

**6. Open <http://localhost:5173>.** The bottom of the left sidebar should say **Server and database connected**.
Add a subject first, then an assignment, then tasks and study sessions; the dashboard fills in as you go.

If the sidebar says something else, see [Troubleshooting](#troubleshooting).

## Setting up the database (MongoDB Atlas)

**What is MongoDB Atlas?** MongoDB is the database where StudyFlow keeps your data. Atlas is MongoDB's cloud service: it runs
the database on their computers, and the free tier is enough for this project. (The screens change from time to time, so button
names may differ slightly from the steps below.)

1. **Create a free account** at <https://www.mongodb.com/atlas> and sign in.
2. **Create a cluster** and choose the **free (M0)** tier. A *cluster* is the database server; pick any nearby region.
3. **Create a database user** (Security → *Database Access* → *Add New Database User*). This is a username and password
   **for the application** (not your Atlas login). Give it permission to read and write. Keep the password in a password
   manager. It will go into `server/.env` only.
4. **Allow your computer** (Security → *Network Access* → *Add IP Address* → *Add Current IP Address*). Atlas rejects
   connections from addresses it does not know. **Home and mobile connections change address from time to time. When
   that happens, StudyFlow loses the database until you add the new address again** (see Troubleshooting).
5. **Get the connection string** (your cluster → *Connect* → *Drivers*). It looks like
   `mongodb+srv://<user>:<password>@<cluster-host>/?...`. Replace `<password>` with your database user's password. If the
   password contains characters such as `@`, `:` or `/`, write them URL-encoded (for example `@` as `%40`).
6. **Put it into `server/.env`** as two variables, with the database name between the final `/` and the `?`:
   - `MONGODB_URI=...mongodb.net/studyflow?...` for the real app (database **studyflow**)
   - `MONGODB_TEST_URI=...mongodb.net/studyflow_test?...` for the automated tests (database **studyflow_test**), using the
     same cluster. The tests refuse to run on any other database name. See [Testing](#testing).

You do not create the databases or collections yourself: MongoDB creates them the first time something is saved.

**Why a replica set?** StudyFlow keeps records from pointing at things that were deleted (for example, a task whose
assignment is gone) by saving related changes in one all-or-nothing **transaction**. MongoDB only supports transactions on a
*replica set*. Atlas (including the free tier) always is one. A plain local `mongod` is not; with it, creating assignments
and tasks or deleting subjects fails. To use a local database you must start it as a single-node replica set
(`mongod --replSet rs0`, then run `rs.initiate()` once in `mongosh`). This local setup is described in
`docs/architecture-notes.md` but was **not tested** in this project; Atlas is the verified setup.

**Check the connection** without printing any secret: start the API (`npm run dev:server`) and open
<http://localhost:5000/api/health>. It should show `"database":"connected"`. The API starts even when the database is
unreachable, so this page can tell you which of the two is the problem.

## Environment variables

Only the server has settings. They live in `server/.env` (copy of `server/.env.example`). The website has none.

| Variable | Required | Example (placeholders only) | What it does |
|---|---|---|---|
| `MONGODB_URI` | **Yes** | `mongodb+srv://<db-user>:<db-password>@<cluster-host>/studyflow?retryWrites=true&w=majority` | The real database. The database name must be `studyflow`. |
| `MONGODB_TEST_URI` | For tests | `mongodb+srv://<db-user>:<db-password>@<cluster-host>/studyflow_test?retryWrites=true&w=majority` | The separate test database. **Must** be named `studyflow_test`. |
| `PORT` | No (default `5000`) | `5000` | The port the API listens on. |
| `CLIENT_ORIGIN` | No (default `http://localhost:5173`) | `http://localhost:5173` | The only website address the browser may use to call the API (CORS). Must match the address in your browser exactly. |
| `NODE_ENV` | No (default `development`) | `development` | Use `production` for a production-style run: server errors are then logged without stack traces. |

Optional, for the **website's** dev server only: set the environment variable `API_PROXY_TARGET` (for example
`http://localhost:5001`) if the API is not on `http://localhost:5000`. The website sends every `/api/...` request to the API
through Vite, so the browser never needs the API's address.

**Keeping secrets safe:** `.env` and every `.env.*` file except `.env.example` are git-ignored; `.env.example` contains
placeholders only; the connection string stays on the server and is never sent to the browser, printed in logs, or included
in error messages. An automated test checks these rules.

## Commands

Run these from the **StudyFlow folder** (the one with this README).

| Command | What it does |
|---|---|
| `npm run install:all` | Installs the packages of `server`, `client` and `e2e` |
| `npm run dev:server` | Starts the API with auto-restart on file changes (port 5000) |
| `npm run dev:client` | Starts the website with live reload (port 5173) |
| `npm run build` | Makes the production website in `client/dist` |
| `npm run lint` | Checks the website code with Oxlint |
| `npm test` | Runs all backend tests (about 15 minutes, uses `studyflow_test`) |
| `npm run test:e2e` | Runs all browser tests (about 6 minutes, uses `studyflow_test`) |
| `npm run test:e2e -- reports` | Runs only the browser specs whose file name contains `reports` |
| `npm run check:integrity` | Read-only check that no record points at a missing subject or assignment (add `-- --test` for the test database) |
| `npm start --prefix server` | Starts the API without auto-restart (what a production-style run uses) |
| `npm run preview --prefix client` | Serves the built website from `client/dist` (run `npm run build` first) |

## Production-style run

```bash
npm run build                      # builds the website into client/dist
npm start --prefix server          # the API (set NODE_ENV=production in server/.env)
npm run preview --prefix client    # serves client/dist on port 4173 and forwards /api to the API on port 5000
```

Set `CLIENT_ORIGIN` in `server/.env` to the address the website is served from (the preview server uses
`http://localhost:4173`). **The API does not serve the website itself, and there is no hosting or deployment configuration
in this project.** Putting StudyFlow on a real server is outside what was built, and would also need authentication first
(see [Known limitations](#known-limitations)).

## How it works: the rules

**Records** (maximum lengths are enforced by the server, and every input is validated):

| Record | Fields |
|---|---|
| **Subject** | name (required, up to 100 characters, unique ignoring upper/lower case), code (up to 20), instructor (up to 100), description (up to 500), colour (`#rrggbb`) |
| **Assignment** | title (required, up to 150), description (up to 2000), subject (optional), due date (required) and optional due time, priority (Low, Medium, High), status (Not Started, In Progress, Completed), estimated minutes (1 to 10080), type (Homework, Project, Exam, Other) |
| **Task** | title (required, up to 150), description (up to 1000), date (required) and optional time, priority, done or not, and optionally **one** subject **or** one assignment (never both) |
| **Study session** | subject (**required**), assignment (optional), date (required), optional start time, duration (whole minutes, 1 to 1440), type (Reading, Practice, Revision, Group study, Other), notes (up to 1000) |

**Dates and times** are stored as plain text (`2026-10-21`, `14:30`) and are never converted through UTC, so a date cannot move
by a day because of a time zone. Dates must be between 2000-01-01 and 2100-12-31. "Today", "overdue" and "due soon" use the
clock of the browser, which sends it with each request, so a computer with a wrong clock shows wrong deadlines.

**Deadline states** (assignments): *completed*; *overdue* (not completed, and the due date, or the due time today, has passed);
*due soon* (not overdue, due within the next 3 days including today); *upcoming* (later). A completed assignment is never
counted as pending or overdue. Tasks use *completed*, *overdue*, *today* and *upcoming* in the same way.

**Deleting and linking:**
- A subject that assignments, tasks or study sessions still use **cannot be deleted** (the message says what uses it).
- Deleting an assignment **keeps** its tasks and study sessions and clears their link (study time is unaffected).
- A task linked to an assignment shows that assignment's subject; it is read from the assignment, never copied.
- MongoDB has no foreign keys, so the server enforces this with transactions; the details, and how to extend them, are in
  `docs/architecture-notes.md`.

**Calculated, never stored:** dashboard figures, calendar events, report figures and study-time totals are computed from the
saved records each time, so they cannot disagree with your data.

**Settings** are saved in your browser (`localStorage`, key `studyflow.settings.v1`), validated on every read, and fall back
to the defaults when damaged. They do not follow you to another browser or computer.

## API

All paths start with `/api`. Responses are JSON: `{ "success": true, "data": ..., "meta": ... }` on success (`meta` carries
`total`, `page`, `limit` on lists) and `{ "success": false, "error": { "message": "...", "details": [...] } }` on failure
(`details` lists field-by-field problems for validation errors). Status codes: `200`, `201` (created), `400` (invalid input or
id), `404` (not found, or unknown route), `409` (conflict, for example deleting a subject that is in use), `413` (body too large),
`503` (a change conflicted with another one for too long; try again). List endpoints accept `page` and `limit` (up to 200)
and, on assignments, tasks and study sessions, `q` (text search). Browsers also send `now=YYYY-MM-DDTHH:mm` (their local time) so deadline states
are right.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | Server status and, separately, database connection status |
| GET | `/api/subjects` | List subjects (`page`, `limit`) |
| POST | `/api/subjects` | Create a subject |
| GET | `/api/subjects/:id` | Read one subject |
| PUT | `/api/subjects/:id` | Replace a subject's fields |
| DELETE | `/api/subjects/:id` | Delete a subject (409 if still in use) |
| GET | `/api/assignments` | List (`subject`, `status`, `priority`, `timing`, `dueFrom`, `dueTo`, `q`, `sort`, `order`, `page`, `limit`) |
| POST | `/api/assignments` | Create an assignment |
| GET | `/api/assignments/:id` | Read one assignment |
| PUT | `/api/assignments/:id` | Replace an assignment's fields |
| PATCH | `/api/assignments/:id/status` | Change only the status |
| DELETE | `/api/assignments/:id` | Delete an assignment (its tasks and sessions are kept, unlinked) |
| GET | `/api/tasks` | List (`date`, `dateFrom`, `dateTo`, `completed`, `priority`, `timing`, `subject`, `assignment`, `q`, `sort`, `order`, `page`, `limit`) |
| POST | `/api/tasks` | Create a task |
| GET | `/api/tasks/:id` | Read one task |
| PUT | `/api/tasks/:id` | Replace a task's fields |
| PATCH | `/api/tasks/:id/completed` | Tick a task off (or untick it) |
| DELETE | `/api/tasks/:id` | Delete a task |
| GET | `/api/study-sessions` | List (`date`, `dateFrom`, `dateTo`, `subject`, `assignment`, `type`, `q`, `sort`, `order`, `page`, `limit`) |
| GET | `/api/study-sessions/summary` | Study-time totals (overall, by day, by subject) for the same filters |
| POST | `/api/study-sessions` | Create a study session |
| GET | `/api/study-sessions/:id` | Read one study session |
| PUT | `/api/study-sessions/:id` | Replace a study session's fields |
| DELETE | `/api/study-sessions/:id` | Delete a study session |
| GET | `/api/dashboard/stats` | Everything the dashboard shows (`now`, `weekStart`) |
| GET | `/api/calendar` | Events for `from` to `to` (required, at most 62 days; `types`, `subject`, `now`) |
| GET | `/api/reports/summary` | Report figures (`from`, `to`, `subject`, `weekStart`, `now`) |
| GET | `/api/reports/export` | A CSV download (`type` = `assignments`, `tasks` or `study-sessions`, plus the same filters; at most 10,000 rows) |

Unknown query values, repeated parameters and malformed ids are rejected with a `400`; unknown parameters are ignored.

## Testing

**What is tested**

- **Backend** (`server/tests/`, Node's test runner): health, database failure handling, every endpoint's validation and
  errors, invalid ids and missing records, filtering and sorting, deadline calculations, dashboard and report figures against
  known data, CSV escaping, deletion rules, and **real crash tests** that kill the server in the middle of a transaction and
  check that nothing is half-saved.
- **Browser** (`e2e/`, a real Chrome on the production build): every page's features, the full student journey, accessibility
  scans (axe-core, WCAG A/AA rules) of every page and state, keyboard use, four screen widths (320, 375, 768, 1280 px),
  loading / error / unreachable states, time zones, hostile text, and that no secrets reach the browser.
- **Project checks** without a database: `server/tests/hygiene.test.js` (no leftover debug code, no credentials in files,
  `.env` ignored, no unused dependencies) and `server/tests/docs.test.js` (this README matches the code).

**Last verified results** (2026-10-22, Windows 11, Node 24.20.0, Atlas M0): the full backend suite passed in one run
(343 tests, about 14 minutes), the 8 hygiene tests passed separately, and the full browser suite passed (179 steps, about 6 minutes).
Lint and the production build were clean. These are a record of one verification run, not a promise: run the commands
below to check your own setup.

**How to run them** (all use only the `studyflow_test` database):

```bash
npm test                                   # all backend tests (about 15 minutes)
npm run test:e2e                           # all browser tests (about 6 minutes)
npm run check:integrity -- --test          # read-only link check on the test database
```

From the `server` folder you can run a single backend file, or the ones that need no database:

```bash
node --test --test-concurrency=1 tests/subjects.test.js
node --test tests/hygiene.test.js tests/docs.test.js tests/csv.test.js tests/calendarRules.test.js tests/dates.test.js
```

Backend tests that need a database are skipped automatically when `MONGODB_TEST_URI` is not set.

**Safety of the tests.** Your real data is never touched:
- the test helpers and the test API refuse to connect to any database not named exactly `studyflow_test`;
- everything the tests create carries a unique tag (`zz_test_<8 hex>_`) and **only tagged records are deleted**;
- if `studyflow_test` holds anything the tests did not create, the run stops with a message instead of deleting it;
- run the backend tests and the browser tests **one after the other, never at the same time** (they share the test database).

**Tips.** Keep the computer awake and plugged in during long runs (see Troubleshooting). A few browser tests read the
computer's clock, so they can misbehave if run exactly at midnight. Details about the browser tests: `e2e/README.md`.

## Troubleshooting

| What you see | Likely cause and fix |
|---|---|
| Sidebar says **Server not reachable**, or a page says "Cannot reach the StudyFlow server" | The API is not running. Start it with `npm run dev:server`. If you changed `PORT`, tell the website where the API is (`API_PROXY_TARGET`, above). |
| Sidebar says **Server running, database not connected**, or the API prints `MongoDB NOT connected: ... MongooseServerSelectionError` | Almost always **your IP address is not on the Atlas Network Access list** (it changes). Add your current IP (step 4 above). Also check the user and password in `MONGODB_URI`, that the cluster is not paused, and that you are online. |
| API prints `Database URI is not set. Check server/.env` | `server/.env` is missing or `MONGODB_URI` is empty. Redo step 3 of the quick start. |
| Creating an assignment or task, or deleting a subject, fails with a server error, but reading works | The database is a standalone MongoDB, not a replica set; transactions need a replica set. Use Atlas, or a local single-node replica set (see above). |
| The browser console shows a CORS error | `CLIENT_ORIGIN` must exactly match the website address in the browser (`http://localhost:5173`, not `127.0.0.1`). Restart the API after changing it. |
| `EADDRINUSE` / "port already in use" | Something else uses port 5000 (API) or 5173 (website). Stop it, or change `PORT` and set `API_PROXY_TARGET`. |
| "Cannot delete ... because it is still used by ..." | Working as intended: delete or re-link the assignments, tasks or study sessions that use that subject first. |
| A change fails with "The server is busy with another change to the same data" (503) | Rare. It can happen for up to about 100 seconds after the server crashed in the middle of a change, while the database discards the unfinished transaction. Wait a moment and try again. |
| Tests: `studyflow_test contains N document(s) not created by tests. Refusing to run.` | The test database holds data the tests did not create. Tests never delete it. Inspect it (for example in Atlas) and remove it yourself if it is not needed. |
| Tests: `MONGODB_TEST_URI must use the database "studyflow_test"` | The test address in `server/.env` ends in the wrong database name. |
| Browser tests: `No Chrome or Edge found` | Install Chrome, or set the environment variable `CHROME_PATH` to a Chromium-based browser. |
| Tests are very slow, time out, or fail with `getaddrinfo ENOTFOUND` | Usually the computer went to sleep (Windows "Modern Standby" freezes everything) or the connection dropped. Plug in, turn off sleep for the run, check your connection, and rerun the affected file. `docs/architecture-notes.md` explains how this was diagnosed. |
| The dev script reports `npm audit` findings for `nodemon`, `chokidar` or `braces` | Known and documented below under Known limitations. |

## Known limitations

- **No login, no private data, local/demo use only.** CORS only restricts which *browser pages* may call the API; it does not
  protect the data from other programs. Do not expose the server to a network you do not trust.
- **Settings are per browser.** They are stored in your browser, not in the database, and the date format changes only how
  StudyFlow prints dates (English month and day names for the fixed formats); date boxes in forms follow your browser's language.
- **Study sessions are typed in** (whole minutes); there is no live timer.
- **No dark theme.** It needs a verified colour pass and was left out on purpose.
- **Figures update when you open or reload a page**, not live while you watch.
- **Crash recovery takes about 65 to 75 seconds.** If the server process dies in the middle of a change, nothing from that
  change is ever applied, but the database keeps the unfinished transaction for about a minute; related changes retry
  automatically and succeed after that (or return a 503 after about 100 seconds).
- **Writes that attach things to the same subject or assignment take turns.** Harmless for one person; a ceiling for many users.
- **Very large data:** list endpoints return at most 200 rows per page, calendar requests cover at most 62 days (500 events per
  kind), and CSV exports are limited to 10,000 rows.
- **No hosting or deployment setup.** The API does not serve the built website (see Production-style run).
- **Verified only on** Atlas M0 (MongoDB 8.0.34), Windows 11, Node 24.20.0, and Chrome. A local replica set, other browsers,
  macOS and Linux are expected to work but were **not** tested. Screen readers were not tested (labels and keyboard use are).
- **Node version metadata:** `server/package.json` says Node `>=20`, but the installed Mongoose 9 and Vite 8 need 20.19 or newer.
- **Open dependency audit finding (development only, not fixed).** `npm audit` in `server/` reports 3 high-severity items that
  are one chain: **`nodemon` 3.1.14 → `chokidar` 3.6.0 → `braces` 3.0.3** (advisory
  [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): denial of service through deeply nested patterns in
  `braces` up to and including 3.0.3, which is the newest version published). `nodemon` is used only by `npm run dev:server`; `npm start --prefix server`
  does not use it and `npm audit --omit=dev` reports **0** vulnerabilities. The only fix `npm audit` offers is a breaking
  downgrade to `nodemon@1.14.10`, so none was applied. Options: accept the risk for local development, or replace `nodemon`
  with Node's built-in `node --watch` (a change to the `dev` script that needs your approval). The client and e2e packages report 0.
- **Some browser tests depend on the computer's clock** and could fail if run exactly at midnight.

## Suggested next steps

1. Decide whether to keep `nodemon` or switch the dev script to `node --watch` (removes the audit finding).
2. Add **sign-in and per-user data** before any use beyond a single person on one computer.
3. Add hosting: serve the built website from the API (or a static host), set `NODE_ENV=production`, and use HTTPS.
4. Optional features: a reliable live study timer, a dark theme (with a colour-contrast check), recurring tasks, reminders.
5. Test on other browsers, with screen readers, and on a local replica-set MongoDB.
6. Set up automatic checks (lint, build and the database-free tests) on every change, once the project is in a Git repository.

## More documentation

- `docs/architecture-notes.md`: how data integrity works, behaviours and limitations in detail, and testing notes.
- `e2e/README.md`: how the browser tests work and how to add one.
