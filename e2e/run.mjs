// Runs the browser end-to-end tests:
//   real Chrome (headless) -> client production build (vite preview) -> test API -> database "studyflow_test"
//
//   npm run test:e2e                 (from the project root)  runs every spec
//   npm run test:e2e -- assignments  runs only specs whose file name contains "assignments"
//
// Safe by design: the API it starts refuses any database except "studyflow_test", the tests only
// delete records they created (tagged with a unique prefix), and your real "studyflow" data is never touched.
import { spawn, spawnSync } from 'node:child_process';
// (the client is built by running Vite directly with node, so no shell is involved)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { createSpecContext } from './lib/harness.mjs';
import { CLIENT_DIR, ROOT, N, connectTestDb, tag } from './lib/testDb.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = Number(process.env.E2E_API_PORT) || 5001;
const UI_PORT = Number(process.env.E2E_UI_PORT) || 5175;
const urls = { api: `http://127.0.0.1:${API_PORT}`, app: `http://127.0.0.1:${UI_PORT}` };
const filter = process.argv[2];
const children = [];

function start(name, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.exitedEarly = false;
  child.on('exit', (code) => { if (code) { child.exitedEarly = true; console.error(`[${name}] exited with code ${code}:\n${output}`); } });
  children.push(child);
  return child;
}

async function waitForHealth(url, label) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

// Finds an installed Chrome (or Edge). CHROME_PATH can point at any Chromium-based browser.
async function launchBrowser() {
  if (process.env.CHROME_PATH) return chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* try the next one */ }
  }
  throw new Error('No Chrome or Edge found. Install Chrome, or set CHROME_PATH to a Chromium-based browser.');
}

const db = await connectTestDb();
let browser;
let failed = 0;
let unexpected = 0;
const allEvents = [];
try {
  await db.prepare();
  console.log('Building the client...');
  // NODE_ENV is forced to "production": loading server/.env (for the test database address) also sets NODE_ENV=development,
  // which would otherwise be inherited here and make the tests run against React's slower, noisier DEVELOPMENT build.
  const build = spawnSync(process.execPath, [path.join(CLIENT_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: CLIENT_DIR,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (build.status !== 0) throw new Error(`Client build failed:\n${build.stdout}\n${build.stderr}`);

  start('test-api', process.execPath, [path.join(here, 'lib', 'test-api.mjs')], { cwd: ROOT, env: { ...process.env, E2E_API_PORT: String(API_PORT) } });
  start('client', process.execPath, [path.join(CLIENT_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(UI_PORT), '--strictPort'], {
    cwd: CLIENT_DIR,
    env: { ...process.env, API_PROXY_TARGET: urls.api },
  });
  await waitForHealth(urls.api, 'Test API');
  await waitForHealth(urls.app, 'Client (through its proxy)');
  console.log(`Test API: ${urls.api} (database studyflow_test) | Client: ${urls.app}\n`);

  browser = await launchBrowser();
  const specFiles = fs.readdirSync(path.join(here, 'specs')).filter((file) => file.endsWith('.spec.mjs') && (!filter || file.includes(filter))).sort();
  if (specFiles.length === 0) throw new Error(`No spec files match "${filter}".`);

  for (const file of specFiles) {
    const spec = await import(pathToFileURL(path.join(here, 'specs', file)).href);
    console.log(`=== ${spec.name} (${file}) ===`);
    const ctx = createSpecContext({ browser, urls, db, N, tag, shotsDir: path.join(here, 'screenshots') });
    try {
      await spec.default(ctx);
    } catch (error) {
      ctx.results.push({ id: 'SETUP', name: `${spec.name} crashed outside a step`, status: 'FAIL', detail: error.message });
      console.log(`FAIL  SETUP  ${error.message}`);
    }
    failed += ctx.results.filter((r) => r.status === 'FAIL').length;
    allEvents.push(...ctx.events.map((e) => ({ ...e, spec: spec.name })));
    console.log(`${ctx.results.filter((r) => r.status === 'PASS').length} passed, ${ctx.results.filter((r) => r.status === 'FAIL').length} failed\n`);
    const cleaned = await db.cleanup(); // between specs, so each starts from an empty database
    console.log(`(cleanup: removed ${cleaned.subjects} subjects, ${cleaned.assignments} assignments, ${cleaned.tasks} tasks and ${cleaned.sessions} study sessions created by this spec)\n`);
  }
} catch (error) {
  failed += 1;
  console.error(`\nRUN ERROR: ${error.message}`);
} finally {
  const cleaned = await db.cleanup().catch(() => ({ subjects: '?', assignments: '?', tasks: '?', sessions: '?' }));
  const remaining = await db.counts().catch(() => 'unknown');
  await browser?.close();
  for (const child of children) child.kill();
  await db.close();

  const cancelledGets = allEvents.filter((e) => e.benign);
  const surprises = allEvents.filter((e) => !e.provoked && !e.benign);
  unexpected = surprises.length;
  console.log('SUMMARY');
  console.log(`  failed steps: ${failed}`);
  console.log(`  unexpected browser errors / failed requests: ${unexpected}`);
  for (const e of surprises) console.log(`    [${e.spec}] ${e.step} ${e.kind} ${e.text}`);
  console.log(`  deliberately provoked errors (expected): ${allEvents.filter((e) => e.provoked && !e.benign).length}`);
  console.log(`  harmless cancelled GET requests (navigation / leaving a page): ${cancelledGets.length}`);
  console.log(`  final cleanup removed ${cleaned.subjects} subjects, ${cleaned.assignments} assignments, ${cleaned.tasks} tasks, ${cleaned.sessions} study sessions; collections now: ${JSON.stringify(remaining)}`);
  process.exitCode = failed || unexpected ? 1 : 0;
}
