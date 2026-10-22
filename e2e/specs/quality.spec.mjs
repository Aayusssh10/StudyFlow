import assert from 'node:assert/strict';
import { axeViolations } from '../lib/axe.mjs';
import { sleep, ymd } from '../lib/helpers.mjs';

export const name = 'Quality: accessibility, responsive layout, error and loading states';

// Every page of the app: where it lives, which API call fills it, and what it says while loading.
const PAGES = [
  { path: '/', title: 'Dashboard', api: /\/api\/dashboard\/stats(\?.*)?$/, loading: 'Loading your dashboard...', ready: 'Summary' },
  { path: '/subjects', title: 'Subjects', api: /\/api\/subjects(\?.*)?$/, loading: 'Loading subjects...' },
  { path: '/assignments', title: 'Assignments', api: /\/api\/assignments(\?.*)?$/, loading: 'Loading assignments...' },
  { path: '/tasks', title: 'Daily tasks', api: /\/api\/tasks(\?.*)?$/, loading: 'Loading tasks...' },
  { path: '/calendar', title: 'Calendar', api: /\/api\/calendar(\?.*)?$/, loading: 'Loading calendar...' },
  { path: '/study-sessions', title: 'Study sessions', api: /\/api\/study-sessions(\?.*)?$/, loading: 'Loading study sessions...' },
  { path: '/reports', title: 'Reports', api: /\/api\/reports\/summary(\?.*)?$/, loading: 'Loading report...' },
];
const STATIC_PAGES = [{ path: '/settings', title: 'Settings' }, { path: '/no-such-page', title: 'Page not found' }];
const ALL_PATHS = [...PAGES, ...STATIC_PAGES];

export default async function run(t) {
  const { app, N, step, shot, api } = t;
  const page = await t.newPage();
  const noisy = []; // console output that is not an error (log / info / warn / debug): the app should print none
  const watch = (p) => p.on('console', (message) => { if (['log', 'info', 'warn', 'debug'].includes(message.type())) noisy.push(`${message.type()}: ${message.text().slice(0, 120)}`); });
  watch(page);
  const json = (status, message) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message } }) });

  const open = async (path, p = page) => {
    await p.goto(`${app}${path}`);
    await p.getByRole('heading', { level: 1 }).first().waitFor();
    await p.waitForLoadState('networkidle');
  };
  const mk = async (route, body) => {
    const res = await api('POST', route, body);
    assert.equal(res.status, 201, `${route}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  async function expectNoViolations(label, p = page) {
    const found = await axeViolations(p);
    assert.deepEqual(found, [], `${label}:\n${found.join('\n')}`);
  }

  // ---------- titles and focus ----------
  await step('Q1', 'Every page has its own title; moving to another page moves keyboard focus to the content', async () => {
    await open('/');
    assert.equal(await page.title(), 'Dashboard - StudyFlow');
    for (const { path, title } of ALL_PATHS) {
      await open(path);
      assert.equal(await page.title(), `${title} - StudyFlow`, `title of ${path}`);
    }
    await open('/');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports' }).click();
    await page.getByRole('heading', { name: 'Reports', level: 1 }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main', 'focus moved to the main content');
    assert.equal(await page.title(), 'Reports - StudyFlow');
    await page.goBack();
    await page.getByRole('heading', { name: 'Dashboard', level: 1 }).waitFor();
    assert.equal(await page.title(), 'Dashboard - StudyFlow', 'the title follows the Back button too');
  });

  // ---------- loading, error and unreachable states, uniformly ----------
  for (const [index, spec] of PAGES.entries()) {
    await step(`Q2.${index + 1}`, `${spec.title}: a loading message while waiting, a clear error with "Try again", and a "Cannot reach" message`, { provoked: true }, async () => {
      // loading
      await page.route(spec.api, async (route) => {
        await sleep(1400);
        try { await route.continue(); } catch { /* page already moved on */ }
      });
      await page.goto(`${app}${spec.path}`);
      await page.getByText(spec.loading).waitFor({ timeout: 1200 });
      await page.getByRole('heading', { level: 1 }).first().waitFor();
      await page.getByText(spec.loading).waitFor({ state: 'detached' });
      await page.unroute(spec.api);

      // server error
      await page.route(spec.api, (route) => route.fulfill(json(500, 'Something went wrong on the server.')));
      await page.goto(`${app}${spec.path}`);
      const alert = page.getByRole('alert').filter({ hasText: 'Something went wrong on the server.' });
      await alert.waitFor();
      assert.ok(await page.getByRole('heading', { level: 1 }).first().isVisible(), 'the page is not blank');
      assert.equal(await page.getByText(spec.loading).count(), 0, 'no endless "loading" next to the error');
      await page.unroute(spec.api);
      await alert.getByRole('button', { name: 'Try again' }).click();
      await alert.waitFor({ state: 'detached' });

      // server unreachable
      await page.route(spec.api, (route) => route.abort('failed'));
      await page.goto(`${app}${spec.path}`);
      await page.getByRole('alert').filter({ hasText: 'Cannot reach the StudyFlow server' }).waitFor();
      assert.ok(await page.getByRole('heading', { level: 1 }).first().isVisible());
      await page.unroute(spec.api);
    });
  }

  await step('Q2.8', 'The side-bar status says when the server or the database is not available; Settings works without the server', { provoked: true }, async () => {
    const HEALTH = /\/api\/health(\?.*)?$/;
    await page.route(HEALTH, (route) => route.abort('failed'));
    await page.goto(`${app}/settings`);
    await page.getByText('Server not reachable').waitFor();
    await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
    await page.unroute(HEALTH);
    await page.route(HEALTH, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { status: 'ok', database: 'disconnected' } }) }));
    await page.goto(`${app}/settings`);
    await page.getByText('Server running, database not connected').waitFor();
    await page.unroute(HEALTH);
    await page.goto(`${app}/settings`);
    await page.getByText('Server and database connected').waitFor();
  });

  // ---------- accessibility, empty database first ----------
  await step('Q3', 'Accessibility scan (axe, WCAG A/AA + best practice): every page with an empty database', async () => {
    const problems = [];
    for (const { path } of ALL_PATHS) {
      await open(path);
      const found = await axeViolations(page);
      if (found.length > 0) problems.push(`${path}:\n  ${found.join('\n  ')}`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  // ---------- accessibility with data ----------
  const seeded = {};
  await step('Q4', 'Accessibility scan: every page with realistic data (all states: overdue, done, planned, long text)', async () => {
    seeded.maths = await mk('/subjects', { name: N('Maths'), color: '#2563eb', code: 'MATH101', instructor: 'Dr. Lee', description: 'Algebra and calculus' });
    seeded.history = await mk('/subjects', { name: N('History'), color: '#dc2626' });
    seeded.essay = await mk('/assignments', { title: N('Essay'), dueDate: ymd(0), subject: seeded.maths.id, priority: 'High', description: 'Five pages' });
    await mk('/assignments', { title: N('Overdue'), dueDate: ymd(-3), subject: seeded.history.id, status: 'In Progress' });
    await mk('/assignments', { title: N('Finished'), dueDate: ymd(-6), subject: seeded.maths.id, status: 'Completed' });
    await mk('/assignments', { title: `${N('Long')} ${'W'.repeat(100)}`, dueDate: ymd(12) });
    seeded.task = await mk('/tasks', { title: N('Revise'), date: ymd(0), assignment: seeded.essay.id });
    await mk('/tasks', { title: N('Done task'), date: ymd(0), completed: true, subject: seeded.maths.id });
    await mk('/tasks', { title: N('Missed'), date: ymd(-1) });
    seeded.session = await mk('/study-sessions', { subject: seeded.maths.id, date: ymd(0), durationMinutes: 45, notes: N('chapter 3'), type: 'Revision' });
    await mk('/study-sessions', { subject: seeded.history.id, date: ymd(-2), durationMinutes: 30, notes: N('notes') });
    await mk('/study-sessions', { subject: seeded.maths.id, date: ymd(2), durationMinutes: 60, notes: N('planned') });

    const problems = [];
    for (const { path } of ALL_PATHS) {
      await open(path);
      if (path === '/') await page.getByRole('img', { name: /Study minutes/ }).waitFor();
      if (path === '/reports') await page.getByRole('img', { name: /Study minutes by day/ }).waitFor();
      const found = await axeViolations(page);
      if (found.length > 0) problems.push(`${path}:\n  ${found.join('\n  ')}`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
    await shot(page, 'quality-01-reports');
  });

  await step('Q5', 'Accessibility scan: forms open, a confirm dialog, the calendar dialog, week view, tables and custom ranges', async () => {
    const problems = [];
    const scan = async (label) => { const found = await axeViolations(page); if (found.length > 0) problems.push(`${label}:\n  ${found.join('\n  ')}`); };

    await open('/subjects');
    await page.getByRole('button', { name: 'Add subject', exact: true }).click();
    await page.getByRole('heading', { name: 'Add a subject' }).waitFor();
    await page.getByRole('button', { name: 'Add subject', exact: true }).click(); // submit empty: shows validation errors
    await page.getByText('Subject name is required', { exact: false }).first().waitFor();
    await scan('subject form with validation errors');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('li.subject-card', { hasText: N('History') }).getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').waitFor();
    await scan('subject delete dialog');
    await page.keyboard.press('Escape');

    await open('/assignments');
    await page.getByRole('button', { name: 'Add assignment', exact: true }).click();
    await page.getByRole('heading', { name: 'Add an assignment' }).waitFor();
    await scan('assignment form');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await open('/tasks');
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.getByRole('heading', { name: 'Add a task' }).waitFor();
    await scan('task form');
    await page.getByRole('button', { name: 'Cancel' }).click();
    for (const view of ['Overdue', 'Upcoming', 'All tasks']) {
      await page.getByRole('group', { name: 'Which tasks to show' }).getByRole('button', { name: view, exact: true }).click();
      await page.waitForLoadState('networkidle');
      await scan(`tasks view ${view}`);
    }

    await open('/study-sessions');
    await page.getByRole('button', { name: 'Add session', exact: true }).click();
    await page.getByRole('heading', { name: 'Add a study session' }).waitFor();
    await scan('study session form');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await open('/calendar');
    await page.getByRole('list', { name: 'Events on the selected day' }).getByRole('button').first().click();
    await page.getByRole('dialog').waitFor();
    await scan('calendar event dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await page.locator('li.cal-week-day').first().waitFor();
    await page.getByText('Loading calendar...').waitFor({ state: 'detached' }); // scan the settled page, not the dimmed loading state
    await scan('calendar week view');

    await open('/reports');
    await page.locator('#report-period').selectOption({ label: 'Custom range' });
    await page.locator('#report-from').fill(ymd(-5));
    await page.locator('#report-to').fill(ymd(-9));
    await page.getByRole('alert').waitFor();
    await scan('reports with an invalid custom range');
    await page.locator('#report-to').fill(ymd(0));
    await page.locator('section', { has: page.getByRole('heading', { name: 'Study time by day' }) }).getByText('View as a table').click();
    await scan('reports with a chart table open');

    await open('/settings');
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    await scan('settings with a message');
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await step('Q6', 'Accessibility scan on a phone: the menu closed and open', async () => {
    const phone = await t.newPage({ viewport: { width: 375, height: 812 } });
    watch(phone);
    await open('/', phone);
    await phone.getByRole('img', { name: /Study minutes/ }).waitFor();
    const problems = [];
    let found = await axeViolations(phone);
    if (found.length > 0) problems.push(`menu closed:\n  ${found.join('\n  ')}`);
    await phone.getByRole('button', { name: 'Open menu' }).click();
    await phone.getByRole('navigation', { name: 'Main navigation' }).waitFor();
    assert.equal(await phone.getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded'), 'true');
    found = await axeViolations(phone);
    if (found.length > 0) problems.push(`menu open:\n  ${found.join('\n  ')}`);
    await shot(phone, 'quality-02-phone-menu');
    await phone.getByRole('link', { name: 'Calendar' }).click();
    await phone.getByRole('heading', { name: 'Calendar', level: 1 }).waitFor();
    assert.equal(await phone.getByRole('button', { name: 'Open menu' }).getAttribute('aria-expanded'), 'false', 'the menu closes after choosing a page');
    await phone.context().close();
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  // ---------- responsive layout ----------
  for (const width of [320, 375, 768, 1280]) {
    await step(`Q7.${width}`, `Responsive at ${width}px wide: no sideways scrolling on any page, navigation usable`, async () => {
      const view = await t.newPage({ viewport: { width, height: width >= 768 ? 900 : 700 } });
      watch(view);
      const problems = [];
      for (const { path, title } of ALL_PATHS) {
        await open(path, view);
        if (path === '/' || path === '/reports') await view.getByRole('img', { name: /Study minutes/ }).waitFor();
        const overflow = await view.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) problems.push(`${path} is ${overflow}px wider than the screen`);
        // a control that is cut off on the right edge
        const clipped = await view.evaluate(() => [...document.querySelectorAll('button, a, input, select, textarea')]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > window.innerWidth + 1 && getComputedStyle(el).visibility !== 'hidden'; })
          .map((el) => (el.textContent || el.getAttribute('aria-label') || el.id || el.tagName).trim().slice(0, 30)));
        if (clipped.length > 0) problems.push(`${path}: controls cut off at the right edge: ${clipped.join(', ')}`);
        if (width <= 320 || width === 1280) await shot(view, `quality-${width}-${title.toLowerCase().replace(/\W+/g, '-')}`);
      }
      const menuButton = view.getByRole('button', { name: /(Open|Close) menu/ });
      if (width <= 860) {
        assert.ok(await menuButton.isVisible(), 'the menu button is shown on small screens');
        await menuButton.click();
        assert.ok(await view.getByRole('link', { name: 'Reports' }).isVisible(), 'the menu opens');
      } else {
        assert.ok(await view.getByRole('navigation', { name: 'Main navigation' }).isVisible(), 'the sidebar is shown on wide screens');
        assert.equal(await menuButton.isVisible(), false);
      }
      await view.context().close();
      assert.deepEqual(problems, [], problems.join('\n'));
    });
  }

  // ---------- keyboard use ----------
  await step('Q8', 'Keyboard only: skip link, a visible focus mark everywhere, dialog keeps focus and Esc returns it', async () => {
    await open('/subjects');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Tab');
    assert.equal((await page.evaluate(() => document.activeElement?.textContent?.trim())), 'Skip to main content', 'the first Tab stop is the skip link');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main', 'the skip link moves focus to the content');

    // every control reached by Tab shows a visible focus indicator
    await open('/subjects');
    const weak = [];
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        const style = getComputedStyle(el);
        const text = (el.textContent || el.getAttribute('aria-label') || el.id || el.tagName).trim().slice(0, 30);
        return { text, tag: el.tagName, outline: parseFloat(style.outlineWidth) * (style.outlineStyle === 'none' ? 0 : 1), shadow: style.boxShadow !== 'none' };
      });
      if (info.tag !== 'BODY' && info.outline < 2 && !info.shadow) weak.push(info.text);
    }
    assert.deepEqual(weak, [], `no visible focus mark on: ${weak.join(', ')}`);

    // a dialog opened with the keyboard
    const card = page.locator('li.subject-card', { hasText: N('History') });
    const deleteButton = card.getByRole('button', { name: /^Delete/ });
    await deleteButton.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    // A native modal <dialog> makes the page behind it inert: Tab and Shift+Tab may cycle through the dialog's buttons
    // (or hand focus to the browser's own toolbar, which leaves the page: activeElement is then <body>), but they must
    // NEVER land on a control of the page behind the dialog.
    const landed = [];
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      landed.push(await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return 'body (browser toolbar)';
        return el.closest('dialog') ? `dialog: ${el.textContent.trim().slice(0, 20)}` : `PAGE: ${el.tagName} ${(el.textContent || el.id).trim().slice(0, 20)}`;
      }));
    }
    assert.deepEqual(landed.filter((where) => where.startsWith('PAGE')), [], `focus reached the page behind the dialog. It went: ${landed.join(' > ')}`);
    assert.ok(landed.some((where) => where.startsWith('dialog')), `focus never entered the dialog. It went: ${landed.join(' > ')}`);
    await dialog.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim().startsWith('Delete')), true, 'focus returns to the Delete button');
    await card.waitFor();
  });

  // ---------- debug output and secrets ----------
  await step('Q9', 'No console output besides errors, and nothing secret in the delivered code or in API error answers', async () => {
    assert.deepEqual(noisy, [], `the app printed to the console:\n${noisy.join('\n')}`);

    // every script and style file the app delivered to the browser
    const html = await (await fetch(`${app}/`)).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    assert.ok(assets.length >= 2, 'the page loads its script and style files');
    const lazy = new Set(assets);
    for (const asset of [...assets]) {
      if (!asset.endsWith('.js')) continue;
      const code = await (await fetch(`${app}${asset}`)).text();
      for (const match of code.matchAll(/["'`]\.?\/?(DashboardCharts-[\w-]+\.js)["'`]/g)) lazy.add(`/assets/${match[1]}`);
    }
    for (const asset of lazy) {
      const text = await (await fetch(`${app}${asset}`)).text();
      assert.doesNotMatch(text, /Download the React DevTools|react-devtools/, `${asset} is a development build: the tests must run against the production build`);
      assert.doesNotMatch(text, /mongodb(\+srv)?:\/\//i, `${asset} contains a database address`);
      assert.doesNotMatch(text, /MONGODB_(TEST_)?URI|studyflow_test|\.env\b/, `${asset} mentions the server configuration`);
    }

    // errors never carry stack traces, file paths or secrets
    const missing = await api('GET', '/no-such-route');
    const bad = await api('GET', '/subjects/not-an-id');
    for (const response of [missing, bad]) {
      assert.deepEqual(Object.keys(response.body).sort(), ['error', 'success']);
      assert.doesNotMatch(JSON.stringify(response.body), /stack|node_modules|[A-Z]:\\|mongodb|at .+\(.+:\d+:\d+\)/i);
    }
  });

  // ---------- clean up ----------
  for (const route of ['/study-sessions', '/tasks', '/assignments']) {
    const { body } = await api('GET', `${route}?limit=200`);
    await Promise.all(body.data.map((row) => api('DELETE', `${route}/${row.id}`)));
  }
}
