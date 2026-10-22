import assert from 'node:assert/strict';
import { eventually, sleep, ymd } from '../lib/helpers.mjs';

export const name = 'Dashboard page';

// Monday-to-Sunday week containing today, as the page defines it.
const thisWeek = () => {
  const sinceMonday = (new Date().getDay() + 6) % 7;
  return { from: ymd(-sinceMonday), to: ymd(6 - sinceMonday) };
};
const dayBefore = (dateString) => {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

export default async function run(t) {
  const { app, db, N, tag, step, shot, api } = t;
  const page = await t.newPage();
  const col = db.col;
  const STATS_URL = /\/api\/dashboard\/stats(\?.*)?$/;
  const json500 = { status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Something went wrong on the server.' } }) };

  // ---------- helpers ----------
  const go = async (path = '/', p = page) => {
    await p.goto(`${app}${path}`);
    await p.getByRole('heading', { name: 'Dashboard', level: 1 }).waitFor();
    await p.getByRole('region', { name: 'Summary' }).waitFor();
  };
  const stat = (p, label) => p.getByTestId(`stat-${label}`);
  const statText = async (p, label) => (await stat(p, label).innerText()).trim();
  const expectStats = async (p, expected) => {
    let actual = {};
    await eventually(async () => {
      actual = {};
      for (const key of Object.keys(expected)) actual[key] = await statText(p, key);
      return JSON.stringify(actual) === JSON.stringify(expected);
    }, `stats ${JSON.stringify(expected)}`).catch((error) => { throw new Error(`${error.message}; last seen: ${JSON.stringify(actual)}`); });
  };
  const mk = async (route, body) => {
    const res = await api('POST', route, body);
    assert.equal(res.status, 201, `${route}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  let noteCounter = 0;
  const makeSession = (subject, date, durationMinutes, extra = {}) => {
    noteCounter += 1;
    return mk('/study-sessions', { subject: subject.id, date, durationMinutes, notes: N(`note ${noteCounter}`), ...extra });
  };
  async function clearAll() {
    for (const route of ['/study-sessions', '/tasks', '/assignments']) {
      const { body } = await api('GET', `${route}?limit=200`);
      await Promise.all(body.data.map((row) => api('DELETE', `${route}/${row.id}`)));
    }
  }
  async function storedMinutes(range) {
    const rows = await col('studysessions').find({ notes: { $regex: `^${tag}_`, $options: 'i' } }).toArray();
    return rows.filter((r) => r.date >= range.from && r.date <= range.to).reduce((sum, r) => sum + r.durationMinutes, 0);
  }
  const fmt = (minutes) => {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return `${rest} min`;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  };

  // ---------- empty database ----------
  await step('D1', 'Loading state, then the welcome / empty state with zero figures and no charts', async () => {
    await page.route(STATS_URL, async (route) => {
      await sleep(1500);
      try { await route.continue(); } catch { /* page already moved on */ }
    });
    await page.goto(`${app}/`);
    await page.getByText('Loading your dashboard...').waitFor({ timeout: 1200 });
    await page.getByRole('region', { name: 'Summary' }).waitFor();
    await page.unroute(STATS_URL);
    await page.getByRole('heading', { name: 'Welcome to StudyFlow' }).waitFor();
    await expectStats(page, {
      subjects: '0', 'pending-assignments': '0', 'overdue-assignments': '0', 'due-soon': '0',
      'tasks-today': '0 / 0', 'overdue-tasks': '0', 'study-today': '0 min', 'study-this-week': '0 min',
    });
    assert.equal(await page.getByRole('img', { name: /Study minutes/ }).count(), 0, 'no chart is drawn for no data');
    assert.equal(await page.getByRole('img', { name: /Assignments by status/ }).count(), 0);
    await page.getByText('No study sessions in the last 7 days').waitFor();
    await page.getByText('No assignments yet, so there is nothing to chart.').waitFor();
    await page.getByText('No pending assignments.').waitFor();
    await page.getByText('Nothing is planned for today.').waitFor();
    await page.getByText('Nothing has been added yet.').waitFor();
    assert.equal(await page.getByText('NaN').count() + await page.getByText('undefined').count(), 0);
    await shot(page, 'dashboard-01-empty');
    await page.getByRole('link', { name: 'Add your first subject' }).click();
    await page.waitForURL(/\/subjects$/);
  });

  // ---------- with data ----------
  const seeded = {};
  await step('D2', 'Figures equal what was stored: counts follow the overdue / due-soon rules, study minutes match the database', async () => {
    seeded.maths = await mk('/subjects', { name: N('Maths'), color: '#2563eb' });
    seeded.overdue = await mk('/assignments', { title: N('A overdue'), dueDate: ymd(-2), subject: seeded.maths.id });
    seeded.soon = await mk('/assignments', { title: N('A soon'), dueDate: ymd(2), subject: seeded.maths.id, status: 'In Progress' });
    seeded.later = await mk('/assignments', { title: N('A later'), dueDate: ymd(10), subject: seeded.maths.id });
    seeded.done = await mk('/assignments', { title: N('A done'), dueDate: ymd(-5), status: 'Completed' });
    seeded.taskA = await mk('/tasks', { title: N('T today A'), date: ymd(0) });
    seeded.taskB = await mk('/tasks', { title: N('T today B done'), date: ymd(0), completed: true });
    seeded.taskLate = await mk('/tasks', { title: N('T yesterday'), date: ymd(-1) });
    seeded.s1 = await makeSession(seeded.maths, ymd(0), 45);
    seeded.s2 = await makeSession(seeded.maths, ymd(-1), 30);
    seeded.s3 = await makeSession(seeded.maths, ymd(-3), 20);
    seeded.s4 = await makeSession(seeded.maths, ymd(-20), 100);
    seeded.newest = await mk('/assignments', { title: N('Newest one'), dueDate: ymd(20) });

    await go();
    const week = await storedMinutes(thisWeek());
    await expectStats(page, {
      subjects: '1', 'pending-assignments': '4', 'overdue-assignments': '1', 'due-soon': '1',
      'tasks-today': '1 / 2', 'overdue-tasks': '1', 'study-today': '45 min', 'study-this-week': fmt(week),
    });
    await page.getByText('1 of 5 completed').waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Welcome to StudyFlow' }).count(), 0, 'the welcome card is gone once there is data');
    await shot(page, 'dashboard-02-data');
  });

  await step('D3', 'Charts: drawn from the data, with a text description and a table view that adds up', async () => {
    await go();
    const study = page.getByRole('img', { name: /Study minutes for each of the last 7 days/ });
    await study.waitFor();
    const label = await study.getAttribute('aria-label');
    assert.match(label, /\b45\b/);
    assert.match(label, /\b30\b/);
    assert.match(label, /\b20\b/);
    await page.getByRole('img', { name: /Assignments by status: Not Started 3, In Progress 1, Completed 1/ }).waitFor();
    assert.ok(await study.locator('svg').count() > 0, 'a real chart is rendered');
    assert.ok(await page.locator('.recharts-bar-rectangle').count() > 0, 'bars are drawn');

    const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Study time, last 7 days' }) });
    await panel.getByText('View as a table').click();
    const cells = (await panel.locator('tbody tr td').allInnerTexts()).map((s) => s.trim());
    assert.equal(cells.length, 7, 'one row for each of the 7 days');
    assert.equal(cells.reduce((sum, c) => sum + Number.parseInt(c, 10), 0), 95, '45 + 30 + 20 minutes; the session 20 days ago is not in the last 7 days');
    await panel.getByText('1 h 35 min in the last 7 days').waitFor();
    await shot(page, 'dashboard-03-charts');
  });

  await step('D4', 'Lists: deadlines (earliest first, with state words), today\'s tasks, recent activity (newest first)', async () => {
    await go();
    const deadlines = (await page.getByRole('list', { name: 'Upcoming deadlines' }).locator('li').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
    assert.equal(deadlines.length, 4, 'only pending assignments');
    assert.ok(deadlines[0].includes(N('A overdue')) && deadlines[0].includes('Overdue'));
    assert.ok(deadlines[1].includes(N('A soon')) && deadlines[1].includes('Due soon'));
    assert.ok(deadlines[2].includes(N('A later')) && deadlines[2].includes('Upcoming'));
    assert.ok(deadlines[3].includes(N('Newest one')));
    assert.equal(deadlines.some((text) => text.includes(N('A done'))), false, 'completed assignments are not deadlines');

    const tasks = (await page.getByRole('list', { name: "Today's tasks" }).locator('li').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
    assert.equal(tasks.length, 2);
    assert.ok(tasks.some((text) => text.includes(N('T today A')) && text.includes('Today')));
    assert.ok(tasks.some((text) => text.includes(N('T today B done')) && text.includes('Done')));
    assert.equal(await page.getByRole('list', { name: "Today's study sessions" }).locator('li').count(), 1);

    const activity = (await page.getByRole('list', { name: 'Recent activity' }).locator('li').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
    assert.equal(activity.length, 8, 'at most 8 items');
    assert.match(activity[0], new RegExp(`Added assignment .*${N('Newest one')}`));
  });

  await step('D5', 'Figures are links: they open the matching page already filtered', async () => {
    await go();
    await stat(page, 'overdue-assignments').click();
    await page.waitForURL(/\/assignments\?timing=overdue$/);
    await page.locator('li.assignment-card').first().waitFor();
    assert.equal(await page.locator('#filter-timing').inputValue(), 'overdue', 'the Deadline filter shows what the dashboard counted');
    assert.equal(await page.locator('li.assignment-card').count(), 1);
    await page.getByRole('heading', { name: N('A overdue') }).waitFor();

    await go();
    await stat(page, 'due-soon').click();
    await page.waitForURL(/\/assignments\?timing=dueSoon$/);
    await page.getByRole('heading', { name: N('A soon') }).waitFor();
    assert.equal(await page.locator('li.assignment-card').count(), 1);

    await go();
    await stat(page, 'overdue-tasks').click();
    await page.waitForURL(/\/tasks\?view=overdue$/);
    await page.getByRole('heading', { name: N('T yesterday') }).waitFor();
    assert.equal(await page.locator('li.task-item').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Overdue', exact: true }).getAttribute('class').then((c) => c.includes('tab-active')), true);

    await page.goto(`${app}/assignments?timing=banana&status=nonsense`);
    await page.locator('#filter-timing').waitFor();
    assert.equal(await page.locator('#filter-timing').inputValue(), '', 'unknown filter values in a link are ignored');
  });

  await step('D6', 'Activity links open the record for editing; a missing record gives a clear message', { provoked: true }, async () => {
    await go();
    await page.getByRole('link', { name: N('Newest one') }).click();
    await page.getByRole('heading', { name: 'Edit assignment' }).waitFor();
    assert.equal(await page.locator('#assignment-title').inputValue(), N('Newest one'));
    assert.equal(new URL(page.url()).search, '', 'the one-time edit link is removed from the address');
    await page.goto(`${app}/tasks?edit=64b7f0c2a1b2c3d4e5f60718`);
    await page.getByText('That task could not be found').waitFor();
    await page.goto(`${app}/assignments?edit=not-an-id`);
    await page.getByText('That assignment could not be found').waitFor();
  });

  await step('D7', 'The dashboard follows changes: complete, move, delete', async () => {
    assert.equal((await api('PATCH', `/assignments/${seeded.overdue.id}/status`, { status: 'Completed' })).status, 200);
    assert.equal((await api('PATCH', `/tasks/${seeded.taskA.id}/completed`, { completed: true })).status, 200);
    assert.equal((await api('DELETE', `/study-sessions/${seeded.s1.id}`)).status, 200);
    await go();
    const week = await storedMinutes(thisWeek());
    await expectStats(page, {
      'pending-assignments': '3', 'overdue-assignments': '0', 'due-soon': '1', 'tasks-today': '2 / 2', 'overdue-tasks': '1', 'study-today': '0 min', 'study-this-week': fmt(week),
    });
    await page.getByText('2 of 5 completed').waitFor();
    const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Study time, last 7 days' }) });
    await panel.getByText('50 min in the last 7 days').waitFor();
  });

  await step('D8', 'Server error: a clear message and a working "Try again"', { provoked: true }, async () => {
    await page.route(STATS_URL, (route) => route.fulfill(json500));
    await page.goto(`${app}/`);
    await page.getByRole('alert').getByText('Something went wrong on the server.').waitFor();
    assert.equal(await page.getByRole('region', { name: 'Summary' }).count(), 0, 'no half-drawn figures next to an error');
    await page.unroute(STATS_URL);
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('region', { name: 'Summary' }).waitFor();
    await page.getByRole('heading', { name: 'Dashboard', level: 1 }).waitFor();
  });

  await step('D9', 'Server unreachable: the "Cannot reach" message instead of a blank page', { provoked: true }, async () => {
    await page.route(STATS_URL, (route) => route.abort('failed'));
    await page.goto(`${app}/`);
    await page.getByText('Cannot reach the StudyFlow server').waitFor();
    await page.unroute(STATS_URL);
  });

  await step('D10', 'Accessibility: headings, link names, text alternatives for charts, keyboard navigation', async () => {
    await go();
    assert.equal(await page.locator('h1').count(), 1);
    for (const heading of ['Today', 'Upcoming deadlines', 'Study time, last 7 days', 'Assignments by status', 'Recent activity']) {
      await page.getByRole('heading', { name: heading, level: 2 }).waitFor();
    }
    for (const link of await page.getByRole('region', { name: 'Summary' }).getByRole('link').all()) {
      assert.ok((await link.innerText()).trim().length > 0, 'every figure link has readable text');
    }
    for (const chart of await page.locator('.chart-box').all()) assert.ok((await chart.getAttribute('aria-label')).length > 20, 'charts have a text description');
    await page.getByRole('link', { name: /Overdue tasks/ }).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/tasks\?view=overdue$/);
  });

  await step('D11', 'Phone width: no horizontal scrolling, figures stack, charts fit', async () => {
    const phone = await t.newPage({ viewport: { width: 375, height: 812 } });
    await go('/', phone);
    await phone.getByRole('img', { name: /Study minutes/ }).waitFor();
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `the page is ${overflow}px wider than the screen`);
    const widths = await phone.locator('.chart-box').evaluateAll((boxes) => boxes.map((box) => box.getBoundingClientRect().right));
    assert.ok(widths.every((right) => right <= 375), `a chart sticks out of the screen: ${widths}`);
    await shot(phone, 'dashboard-04-phone');
    await phone.context().close();
  });

  await step('D12', 'Hostile text in titles is shown as plain text, never run as HTML', async () => {
    const evil = `<img src=x onerror="window.__pwned=1"> ${N('xss')}`;
    await mk('/assignments', { title: evil, dueDate: ymd(1) });
    let dialogs = 0;
    page.on('dialog', async (dialog) => { dialogs += 1; await dialog.dismiss(); });
    await go();
    await page.getByText(N('xss')).first().waitFor();
    assert.equal(await page.locator('img[src="x"]').count(), 0);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    assert.equal(dialogs, 0);
    await page.getByText('<img src=x', { exact: false }).first().waitFor();
  });

  await step('D13', 'Very long names wrap instead of widening the page', async () => {
    await mk('/assignments', { title: `${N('long')} ${'W'.repeat(120)}`, dueDate: ymd(1) });
    await go();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `the page is ${overflow}px wider than the screen`);
  });

  // ---------- time zones ----------
  for (const [id, timezoneId] of [['D14', 'Pacific/Kiritimati'], ['D15', 'Pacific/Pago_Pago']]) {
    await step(id, `"Today" follows the browser's own clock (${timezoneId})`, async () => {
      await clearAll();
      const today = new Date().toLocaleDateString('en-CA', { timeZone: timezoneId });
      const yesterday = dayBefore(today);
      const tzPage = await t.newPage({ timezoneId });
      const subject = seeded.maths;
      await makeSession(subject, today, 17);
      await makeSession(subject, yesterday, 11);
      await mk('/assignments', { title: N(`due ${timezoneId} today`), dueDate: today });
      await mk('/assignments', { title: N(`due ${timezoneId} yesterday`), dueDate: yesterday });
      await mk('/tasks', { title: N(`task ${timezoneId} today`), date: today });
      await go('/', tzPage);
      await expectStats(tzPage, { 'study-today': '17 min', 'overdue-assignments': '1', 'due-soon': '1', 'tasks-today': '0 / 1' });
      await tzPage.context().close();
    });
  }

  await clearAll();
}
