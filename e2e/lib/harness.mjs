// Small test harness: runs named steps, records pass/fail, and watches the browser for
// console errors, failed requests and HTTP errors so unexpected ones can fail the run.
import fs from 'node:fs';
import path from 'node:path';

export function createSpecContext({ browser, urls, db, N, tag, shotsDir }) {
  const results = [];
  const events = []; // { step, provoked, kind, text }
  let currentStep = '-';
  let provoked = false;

  // options are passed to Playwright, e.g. { timezoneId: 'Asia/Kolkata' } or { viewport: {...} }
  async function newPage(options = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...options });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') events.push({ step: currentStep, provoked, kind: 'console.error', text: m.text().slice(0, 160) }); });
    page.on('pageerror', (e) => events.push({ step: currentStep, provoked, kind: 'pageerror', text: String(e).slice(0, 160) }));
    page.on('requestfailed', (r) => {
      const errorText = r.failure()?.errorText;
      // A GET the browser cancelled (page navigated away, or the app left a page and cancelled its
      // own read on purpose) is harmless and counted separately. Anything else, above all a cancelled
      // or failed POST/PUT/PATCH/DELETE, is reported as unexpected.
      const harmlessCancel = errorText === 'net::ERR_ABORTED' && r.method() === 'GET';
      events.push({ step: currentStep, provoked, kind: harmlessCancel ? 'cancelled-get' : 'requestfailed', benign: harmlessCancel, text: `${r.method()} ${new URL(r.url()).pathname} ${errorText}` });
    });
    page.on('response', (r) => { if (r.status() >= 400) events.push({ step: currentStep, provoked, kind: `http ${r.status()}`, text: `${r.request().method()} ${new URL(r.url()).pathname}` }); });
    return page;
  }

  // Runs one step. Mark steps that deliberately cause errors with { provoked: true }.
  async function step(id, name, optionsOrFn, maybeFn) {
    const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
    currentStep = id;
    provoked = Boolean(options.provoked);
    const started = Date.now();
    try {
      await fn();
      results.push({ id, name, status: 'PASS', ms: Date.now() - started });
    } catch (error) {
      results.push({ id, name, status: 'FAIL', ms: Date.now() - started, detail: String(error.message).split('\n').slice(0, 8).join(' | ') });
    }
    const last = results.at(-1);
    console.log(`${last.status}  ${id}  ${name}${last.detail ? `\n        ${last.detail}` : ''}`);
  }

  fs.mkdirSync(shotsDir, { recursive: true });
  const shot = (page, name) => page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: true });

  // Talks to the test API directly (used to create test data quickly, like a user who already has data).
  async function api(method, route, body) {
    const response = await fetch(`${urls.api}/api${route}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  return { app: urls.app, db, N, tag, results, events, newPage, step, shot, api };
}
