# StudyFlow: architecture notes

Technical notes for a person running or extending StudyFlow: requirements, how data integrity is kept, behaviours and
limitations, and testing notes. The [README](../README.md) covers setup and everyday use and links here for the details;
where the two overlap, the README is the short version. These notes were written phase by phase, so some bullets mention
the phase in which something was added.

## 1. Requirements

### MongoDB must be a replica set (transactions are required)
StudyFlow uses multi-document **transactions** to keep records from pointing at deleted subjects or assignments
(see section 2). Transactions only work on a **replica set** (or sharded cluster).
- **MongoDB Atlas (including the free M0 tier) is a replica set**: it works.
- A plain local `mongod` started without replication is a *standalone* server: transactions fail, and creating
  assignments or tasks, or deleting subjects or assignments, will return errors. To use a local database, start it
  as a single-node replica set (`mongod --replSet rs0`, then run `rs.initiate()` once).
- Verified on: MongoDB 8.0.34, Atlas M0 (3-member replica set).

### The Atlas IP access list must include your current public IP
Atlas only accepts connections from addresses on its **Network Access** list. Home and mobile internet providers
change your public IP from time to time. When that happens, every connection fails with
`MongooseServerSelectionError` (the API's `/api/health` shows `database: "disconnected"`, tests fail to connect).
**Fix:** Atlas, Network Access, Add IP Address, "Add Current IP Address". (This happened during Phase 5.)

### Node.js 20 or newer; Chrome or Edge for the browser tests
Browser tests (`npm run test:e2e`) drive an installed Chrome (or Edge, or `CHROME_PATH`). They need
`MONGODB_TEST_URI` pointing at a database named exactly `studyflow_test`.

## 2. How data integrity is kept (no "dangling" links)

Records that point at others:

| Record | Points at | Rule |
|---|---|---|
| Assignment | one subject (optional) | a subject that assignments use **cannot be deleted** (409) |
| Task | one subject **or** one assignment (optional, never both) | a subject that tasks use **cannot be deleted** (409); deleting an assignment **keeps its tasks and clears their link** |
| Study session | one subject (**required**) and one assignment (optional) | a subject that sessions use **cannot be deleted** (409); deleting an assignment **keeps its sessions and clears their link** (the study time is unaffected) |

A task linked to an assignment shows that assignment's subject. It is read from the assignment and never copied.

MongoDB has no foreign keys, so the application enforces this (`server/src/utils/transaction.js`):
1. Every write that creates or changes such a link, and every deletion of a subject or assignment, runs in
   **one all-or-nothing transaction** (`inTransaction`). If the server dies halfway, MongoDB discards the unfinished
   transaction; nothing is half-saved.
2. Writes that create a link first **lock the target** (`lockSubjectForReference` / `lockAssignmentForReference`)
   by incrementing a hidden counter on it. Deleting the target also writes that same document, so two overlapping
   transactions conflict and one is retried. **Transactions alone are not enough** (without the shared write, two
   transactions can both commit and leave an orphan; reproduced on Atlas).
3. Retries use their own randomized back-off loop (the driver's built-in loop retries instantly and starves waiting
   requests on the free tier).

The map of who points at whom is `server/src/utils/subjectReferences.js`. **Every new feature that points at a subject
or assignment must follow the same pattern and be added to that map.** Copy the tests in
`server/tests/referenceIntegrity.test.js` and `taskIntegrity.test.js`.

`npm run check:integrity` (add `-- --test` for the test database) is a **read-only** detector for dangling links.
It exists because edits made outside the app (Compass, scripts, restored backups) bypass the rules above.

## 3. Behaviour and limitations to document

- **Crash recovery takes about 65 to 75 seconds.** If the server process dies in the middle of a transaction, nothing
  from that transaction is ever applied (verified with real process kills). But the database keeps the abandoned
  transaction for about a minute (its lifetime limit, not adjustable on Atlas M0), and during that time other writes to
  the same subject or assignment are retried automatically. They succeed once Atlas discards it (measured 65 and 74
  seconds), or return `503 "The server is busy..."` after about 100 seconds.
- **Writes that attach things to the same subject or assignment take turns** (each locks that one document). That is
  harmless for one person using the app; it is a throughput ceiling for many simultaneous users.
- **No login and no per-user data.** Everyone who can reach the server sees and changes the same data. Local/demo use only.
- **Dates and times are plain text** (`YYYY-MM-DD`, `HH:mm`), never converted through UTC, so they cannot shift by a
  day. "Overdue", "due soon" and "today" use the clock of the browser, which sends it with each request (`?now=`).
- **A due-soon window is a fixed 3 days.**
- **Study sessions record time spent on a subject; the duration is typed in (whole minutes, 1 to 1440). There is no live
  timer.** Totals (today, this week, all time, per day, per subject) are **always calculated by the server from the stored
  sessions** (`GET /api/study-sessions/summary`, same filters as the list); no total is ever stored, so totals cannot
  disagree with the sessions. A session may be dated in the future (a planned session). A session's subject and the
  subject of its linked assignment may differ (the form only suggests the assignment's subject as a shortcut).
- **"This week" is Monday to Sunday.** A week-start preference arrives with the Settings page (Phase 8).
- **Session types** (`Reading`, `Practice`, `Revision`, `Group study`, `Other`) were chosen by the developer; the original
  specification only says "optional session type".
- **The subject drop-down lists up to 100 subjects; the assignment drop-down in the task form lists up to 200 assignments.**
- **The dashboard and the calendar store nothing.** `GET /api/dashboard/stats` and `GET /api/calendar` read the same
  collections and use the same rules as the list pages (`assignmentTiming`, `taskTiming`, and the shared
  `utils/studySummary.js` aggregation), so a figure on the dashboard always equals what the matching page shows.
  Dashboard figures: assignment totals (pending / completed / overdue / due soon), tasks planned today (done / overdue),
  study minutes (today, this Monday-Sunday week, all time) and the last 7 days (every day present, 0 when empty).
- **Calendar rules.** The browser asks for the visible days only (`from`/`to`, inclusive, at most 62 days). Assignments
  appear on their due date, tasks on their date, study sessions on their date. A session is labelled **planned** while it
  is later than the browser's clock (a later day, or a later start time today) and **recorded** otherwise; a session
  without a start time dated today counts as recorded. A subject filter includes tasks linked to that subject directly
  **or** through one of its assignments. A very busy range is cut at 500 events per kind and the response says so
  (`truncated`). A record whose subject or assignment is missing (damage made outside the app) still appears, without
  a subject, instead of breaking the page.
- **Links between pages.** The calendar and the dashboard open records with `?edit=<id>` (Assignments, Tasks, Study
  sessions). The link is used once and removed from the address; a record that no longer exists gives a message.
  Dashboard cards link to `/assignments?timing=overdue|dueSoon` and `/tasks?view=overdue`. The pending-assignments card
  links to the unfiltered Assignments page (there is no "pending" filter, so its count is not what that page lists first).
- **Charts** (Recharts, loaded only when a chart is shown) have a text description and a "View as a table" fallback.
  Recent activity is based on each record's last-changed time; linking a task or session to an assignment does not
  count as changing the assignment.
- **Reports store nothing either** (`GET /api/reports/summary`). One filter set (optional `from`/`to`, optional `subject`,
  `weekStart`, `now`) applies to all three kinds of record: assignments by **due date**, tasks by their **day**, study
  sessions by their **date**. A task counts for a subject directly or through its assignment (the same rule as the
  calendar). Completion percentages are whole numbers, and are `null` ("no data", shown as a dash) when there is nothing
  to divide: 0% only ever means "there is data and none of it is complete". The study-by-day chart fills days without
  study with 0 for ranges up to 31 days, and switches to weeks for longer ones.
- **CSV exports** (`GET /api/reports/export?type=assignments|tasks|study-sessions`, same filters): comma separated, CRLF
  line ends, UTF-8 with a byte-order mark so Excel reads accents; cells with commas, quotes or line breaks are quoted
  and quotes are doubled. **Spreadsheet formula injection is neutralized**: a text cell that starts with `=`, `+`, `-`,
  `@`, a tab or a carriage return (also after leading spaces) gets a leading apostrophe. Real numbers (durations) are not
  touched. An export of more than 10,000 rows is refused with a message to narrow the range. Errors are JSON (400), and
  no download is offered for them.
- **Settings are stored in the browser only** (`localStorage`, key `studyflow.settings.v1`): week start (Monday or
  Sunday), date format and time format. There are no accounts, so nothing is stored on the server and the settings do
  not follow you to another browser. Saved values are validated on every read and write; a damaged, unknown or
  hand-edited value falls back to the default for that setting. If the browser blocks storage the setting applies until
  the page is closed and the page says so. The week start reaches the server as `?weekStart=` (dashboard, reports); the
  calendar and the study-sessions page apply it in the browser. **The date format changes how StudyFlow prints dates**
  (English month and day names for the fixed formats); the date boxes inside forms always follow the browser's own
  language. A dark theme was not built (it needs a verified colour pass); it is a sensible next step.
- **Not verified:** two separately running server processes deliberately racing each other (the database rules should
  make this equivalent); browsers other than Chrome; screen readers (labels and keyboard use are tested).

## 4. Testing notes

- Backend: `npm test` (about 8 to 12 minutes against Atlas; it includes two tests that really kill a server process
  and wait about 70 seconds for recovery). Browser: `npm run test:e2e` (about 2.5 minutes).
- Tests use only the database `studyflow_test`, tag everything they create with a unique prefix
  (`zz_test_xxxxxxxx_`), delete only what they created, and refuse to run if that database holds anything else.
- The test servers refuse to start against any other database name.
- **Keep the computer awake while the tests run.** Windows "Modern Standby" (screen-off idle sleep, common on laptops,
  especially on battery) freezes every process and drops the network. During Phase 5 this produced runs that took
  184 s, 356 s or more instead of about 75 s, DNS errors (`getaddrinfo ENOTFOUND`) and timers that fired minutes late.
  This was proven with exact timestamps: a diagnostic whose 240-second timer fired after 467 s matched a standby
  that began at 14:54:14 and ended at 15:01:50 in the Windows power log (Event Viewer, System, Kernel-Power events
  506 = entering standby, 507 = exiting). If a run misbehaves, check that log before suspecting the database. Plug in
  the laptop, or turn off screen-sleep for the duration of a test run.
- **Browser tests run against the production build.** `e2e/run.mjs` forces `NODE_ENV=production` for the client build
  (loading `server/.env` sets `NODE_ENV=development`, which used to leak into the build and make Phases 2 to 8 run against
  React's development bundle). The quality spec fails if the delivered code is a development build.
- **Quality checks (Phase 9):** `quality.spec.mjs` runs axe-core (WCAG 2.0/2.1 A and AA plus best-practice rules) on every
  page in empty and data states, with forms, dialogs, chart tables and the phone menu open; checks page titles, focus after
  navigation, keyboard-only use, no sideways scrolling at 320, 375, 768 and 1280 px, loading / error / unreachable
  states on every page, no console output, and no secrets in the delivered code or error answers. `workflow.spec.mjs` is
  one student journey through the UI. `server/tests/hygiene.test.js` (no database) guards against debug code, focused tests,
  credentials in source, an unprotected `.env`, and unused runtime dependencies. Automated scans cannot judge everything
  (for example whether wording makes sense); screen readers were not tested.
- **Known dependency finding (development only):** `npm audit` in `server/` reports 3 high-severity items, all one chain:
  `nodemon 3.1.14 -> chokidar 3.6.0 -> braces 3.0.3` (GHSA-vfj7-8cjw-p6xm, denial of service through deeply nested
  patterns, affected range `<=3.0.3`, and 3.0.3 is the newest published). `nodemon` is only used by `npm run dev`;
  `npm audit --omit=dev` reports 0, and `npm start` does not use it. The only fix npm offers is a breaking downgrade to
  `nodemon@1.14.10`, so none was applied. Options: accept the risk, or replace `nodemon` with Node's built-in `node --watch`.
- A flaky home connection can also break a test run (for example `getaddrinfo ENOTFOUND` when DNS briefly fails); re-run.
- Real-crash tests (`referenceIntegrity.test.js`, `taskIntegrity.test.js`) deliberately wait for the database to discard
  an abandoned transaction (60 to 90 s). They have strict deadlines (a request that has not answered after 170 s fails
  the test) and print a timeline of where the time went. A timeout is always a failure, never a pass.
