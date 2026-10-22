import assert from 'node:assert/strict';
import fs from 'node:fs';
import { eventually, parseCsv, sleep, ymd } from '../lib/helpers.mjs';

export const name = 'Reports page';

const dayBefore = (dateString) => {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};
const fmt = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

export default async function run(t) {
  const { app, db, N, tag, step, shot, api } = t;
  const page = await t.newPage({ acceptDownloads: true });
  const col = db.col;
  const SUMMARY_URL = /\/api\/reports\/summary(\?.*)?$/;
  const EXPORT_URL = /\/api\/reports\/export(\?.*)?$/;
  const json = (status, message) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message } }) });

  // ---------- helpers ----------
  const go = async (path = '/reports', p = page) => {
    await p.goto(`${app}${path}`);
    await p.getByRole('heading', { name: 'Reports', level: 1 }).waitFor();
    await p.getByRole('region', { name: 'Report figures' }).waitFor();
  };
  const figure = (p, id) => p.getByTestId(`figure-${id}`);
  const figureText = async (p, id) => (await figure(p, id).innerText()).replace(/\s+/g, ' ').trim();
  const expectFigures = async (p, expected) => {
    let actual = {};
    await eventually(async () => {
      actual = {};
      for (const key of Object.keys(expected)) actual[key] = await figureText(p, key);
      return Object.entries(expected).every(([key, want]) => (want instanceof RegExp ? want.test(actual[key]) : actual[key] === want));
    }, `figures ${JSON.stringify(expected)}`).catch((error) => { throw new Error(`${error.message}; last seen: ${JSON.stringify(actual)}`); });
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
  // Study minutes straight from the DATABASE, independently of the page.
  async function storedMinutes({ from, to, subjectId } = {}) {
    const rows = await col('studysessions').find({ notes: { $regex: `^${tag}_`, $options: 'i' } }).toArray();
    return rows
      .filter((r) => (!from || r.date >= from) && (!to || r.date <= to) && (!subjectId || r.subject.toString() === subjectId))
      .reduce((sum, r) => sum + r.durationMinutes, 0);
  }
  async function download(p, buttonName) {
    const [file] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: buttonName, exact: true }).click()]);
    const bytes = fs.readFileSync(await file.path());
    return { filename: file.suggestedFilename(), bytes, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) };
  }
  const pickPeriod = (label, p = page) => p.locator('#report-period').selectOption({ label });
  const today = ymd(0);
  const seeded = {};

  // ---------- empty database ----------
  await step('P1', 'Loading state, then an honest empty report: dashes instead of 0% or NaN, messages instead of charts', async () => {
    await page.route(SUMMARY_URL, async (route) => {
      await sleep(1500);
      try { await route.continue(); } catch { /* page already moved on */ }
    });
    await page.goto(`${app}/reports`);
    await page.getByText('Loading report...').waitFor({ timeout: 1200 });
    await page.getByRole('region', { name: 'Report figures' }).waitFor();
    await page.unroute(SUMMARY_URL);
    await expectFigures(page, {
      'assignment-completion': 'Assignment completion — No assignments due in this period',
      pending: /^Pending assignments 0 /,
      'task-completion': 'Task completion — No tasks in this period',
      'study-time': 'Study time 0 min No study sessions in this period',
      average: /^Average per study day — /,
    });
    await page.getByText('No study sessions in this period, so there is nothing to chart.').waitFor();
    await page.getByText('No assignments are due in this period, so there is nothing to chart.').waitFor();
    assert.equal(await page.getByRole('img').count(), 0, 'no chart is drawn for no data');
    assert.equal(await page.getByText('NaN').count() + await page.getByText('Infinity').count() + await page.getByText('undefined').count(), 0);
    assert.equal(await page.locator('#report-period').inputValue(), 'last30', 'the default period is the last 30 days');
    await shot(page, 'reports-01-empty');
  });

  await step('P2', 'An empty export is a CSV with just the header row', async () => {
    const { filename, bytes, text } = await download(page, 'Export assignments');
    assert.equal(filename, `studyflow-assignments-${today}.csv`);
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'a byte-order mark so Excel reads accents correctly');
    const rows = parseCsv(text.slice(1));
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0], 'Title');
    await page.getByRole('status').filter({ hasText: `exported as studyflow-assignments-${today}.csv` }).waitFor();
  });

  // ---------- with known data ----------
  await step('P3', 'Last 30 days: every figure equals the hand-calculated value for the known data', async () => {
    seeded.maths = await mk('/subjects', { name: N('Maths'), color: '#2563eb' });
    seeded.history = await mk('/subjects', { name: N('History'), color: '#dc2626' });
    await mk('/assignments', { title: N('A1 done'), dueDate: ymd(-10), subject: seeded.maths.id, status: 'Completed' });
    await mk('/assignments', { title: N('A2 overdue'), dueDate: ymd(-5), subject: seeded.maths.id });
    await mk('/assignments', { title: N('A3 soon'), dueDate: ymd(2), subject: seeded.history.id, status: 'In Progress' });
    await mk('/assignments', { title: N('A4 old'), dueDate: ymd(-40), subject: seeded.maths.id, status: 'Completed' });
    await mk('/tasks', { title: N('T1 done'), date: ymd(-3), subject: seeded.maths.id, completed: true });
    await mk('/tasks', { title: N('T2 missed'), date: ymd(-1) });
    await mk('/tasks', { title: N('T3 today'), date: ymd(0) });
    await mk('/tasks', { title: N('T4 old'), date: ymd(-50), completed: true });
    await makeSession(seeded.maths, ymd(0), 45);
    await makeSession(seeded.maths, ymd(-1), 30);
    await makeSession(seeded.history, ymd(-3), 20);
    await makeSession(seeded.maths, ymd(-40), 100);

    await go();
    await expectFigures(page, {
      'assignment-completion': 'Assignment completion 50% 1 of 2 completed',
      pending: 'Pending assignments 1 1 overdue, 0 due soon',
      'task-completion': 'Task completion 33% 1 of 3 done, 1 overdue',
      'study-time': 'Study time 1 h 35 min 3 sessions on 3 days',
      average: 'Average per study day 32 min only days with a session count',
    });
    assert.equal(await storedMinutes({ from: ymd(-29), to: today }), 95, 'the database agrees with the 95 minutes on the page');
    await shot(page, 'reports-02-last30');
  });

  await step('P4', 'Charts: daily bars with a text description, a table that adds up, and the status chart', async () => {
    await go();
    const chart = page.getByRole('img', { name: /Study minutes by day/ });
    await chart.waitFor();
    assert.ok(await chart.locator('svg').count() > 0, 'a real chart is drawn');
    const label = await chart.getAttribute('aria-label');
    assert.match(label, /\b45\b/);
    assert.match(label, /\b30\b/);
    assert.doesNotMatch(label, /\b100\b/, 'the 100-minute session 40 days ago is outside the period');
    const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Study time by day' }) });
    await panel.getByText('1 h 35 min in this period').waitFor();
    await panel.getByText('View as a table').click();
    const cells = (await panel.locator('tbody tr td').allInnerTexts()).map((s) => s.trim());
    assert.equal(cells.length, 30, 'one row for each of the 30 days, including days without study');
    const sum = cells.reduce((total, c) => total + (/(\d+) h/.test(c) ? Number(/(\d+) h/.exec(c)[1]) * 60 : 0) + (/(\d+) min/.test(c) ? Number(/(\d+) min/.exec(c)[1]) : 0), 0);
    assert.equal(sum, 95);
    await page.getByRole('img', { name: /Assignments by status: Not Started 1, In Progress 0, Completed 1/ }).waitFor();
  });

  await step('P5', 'Study time by subject: shares add up to the total', async () => {
    await go();
    const rows = (await page.getByRole('list', { name: 'Study time by subject' }).locator('li').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
    assert.equal(rows.length, 2);
    assert.ok(rows[0].includes(N('Maths')) && rows[0].includes('1 h 15 min (79%)'), rows[0]);
    assert.ok(rows[1].includes(N('History')) && rows[1].includes('20 min (21%)'), rows[1]);
  });

  await step('P6', 'All time: more records are counted, and the chart switches to weeks', async () => {
    await go();
    await pickPeriod('All time');
    await expectFigures(page, {
      'assignment-completion': 'Assignment completion 50% 2 of 4 completed',
      pending: 'Pending assignments 2 1 overdue, 1 due soon',
      'task-completion': 'Task completion 50% 2 of 4 done, 1 overdue',
      'study-time': 'Study time 3 h 15 min 4 sessions on 4 days',
      average: 'Average per study day 49 min only days with a session count',
    });
    await page.getByRole('heading', { name: 'Study time by week' }).waitFor();
    const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Study time by week' }) });
    await panel.getByText('3 h 15 min in this period').waitFor();
    await panel.getByText('View as a table').click();
    const rows = await panel.locator('tbody tr').count();
    assert.ok(rows >= 2 && rows <= 8, `${rows} weekly rows for sessions up to 40 days apart`);
    assert.equal(await storedMinutes(), 195);
  });

  await step('P7', 'Other periods: This week, Last 7 days, This month follow the same calculation as the database', async () => {
    await go();
    for (const [label, rangeOf] of [
      ['Last 7 days', () => ({ from: ymd(-6), to: today })],
      ['This month', () => ({ from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-31` })],
    ]) {
      await pickPeriod(label);
      const range = rangeOf();
      const want = await storedMinutes(range);
      await expectFigures(page, { 'study-time': want === 0 ? /^Study time 0 min/ : new RegExp(`^Study time ${fmt(want)} `) });
    }
    await pickPeriod('This week');
    const sinceMonday = (new Date().getDay() + 6) % 7;
    const want = await storedMinutes({ from: ymd(-sinceMonday), to: ymd(6 - sinceMonday) });
    await expectFigures(page, { 'study-time': want === 0 ? /^Study time 0 min/ : new RegExp(`^Study time ${fmt(want)} `) });
    await page.getByText('Showing', { exact: false }).first().waitFor();
  });

  await step('P8', 'Custom range: inclusive dates; "From after To" is rejected without asking the server', async () => {
    await go();
    await pickPeriod('Custom range');
    await page.locator('#report-from').fill(ymd(-1));
    await page.locator('#report-to').fill(ymd(-1));
    await expectFigures(page, { 'study-time': 'Study time 30 min 1 session on 1 day' });
    await page.locator('#report-from').fill(ymd(-3));
    await page.locator('#report-to').fill(ymd(0));
    await expectFigures(page, { 'study-time': 'Study time 1 h 35 min 3 sessions on 3 days' });

    let asked = 0;
    await page.route(SUMMARY_URL, async (route) => { asked += 1; await route.continue(); });
    await page.locator('#report-to').fill(ymd(-5));
    await page.getByRole('alert').getByText('"From" must not be after "To".').waitFor();
    await page.waitForTimeout(400);
    assert.equal(asked, 0, 'an impossible range is not sent to the server');
    assert.equal(await page.locator('#report-to').getAttribute('aria-invalid'), 'true');
    await page.unroute(SUMMARY_URL);
    await page.locator('#report-to').fill(ymd(-1));
    await page.getByRole('alert').waitFor({ state: 'detached' });
    await expectFigures(page, { 'study-time': 'Study time 50 min 2 sessions on 2 days' });
    await page.locator('#report-from').fill('');
    await page.locator('#report-to').fill('');
    await expectFigures(page, { 'study-time': 'Study time 3 h 15 min 4 sessions on 4 days' });
  });

  await step('P9', 'Subject filter changes every figure and chart', async () => {
    await go();
    await page.locator('#report-subject').selectOption({ label: N('History') });
    await expectFigures(page, {
      'assignment-completion': 'Assignment completion — No assignments due in this period',
      'study-time': 'Study time 20 min 1 session on 1 day',
    });
    await pickPeriod('All time');
    await expectFigures(page, { 'assignment-completion': 'Assignment completion 0% 0 of 1 completed', 'study-time': 'Study time 20 min 1 session on 1 day' });
    await page.locator('#report-subject').selectOption({ label: N('Maths') });
    await expectFigures(page, { 'assignment-completion': 'Assignment completion 67% 2 of 3 completed', 'study-time': 'Study time 2 h 55 min 3 sessions on 3 days' });
    assert.equal(await storedMinutes({ subjectId: seeded.maths.id }), 175);
  });

  await step('P10', 'CSV exports match the report: row counts, durations, order, file names', async () => {
    await go();
    const a = await download(page, 'Export assignments');
    const assignmentRows = parseCsv(a.text.slice(1));
    assert.equal(a.filename, `studyflow-assignments-${today}.csv`);
    assert.deepEqual(assignmentRows[0], ['Title', 'Subject', 'Type', 'Priority', 'Status', 'Due date', 'Due time', 'Estimated minutes', 'Deadline', 'Description']);
    assert.equal(assignmentRows.length - 1, 2, 'the two assignments due in the last 30 days');
    assert.deepEqual(assignmentRows.slice(1).map((r) => r[5]), [ymd(-10), ymd(-5)], 'ordered by due date');
    assert.deepEqual(assignmentRows.slice(1).map((r) => r[8]), ['completed', 'overdue']);

    const s = await download(page, 'Export study sessions');
    const sessionRows = parseCsv(s.text.slice(1));
    assert.equal(s.filename, `studyflow-study-sessions-${today}.csv`);
    assert.equal(sessionRows.length - 1, 3);
    assert.equal(sessionRows.slice(1).reduce((sum, r) => sum + Number(r[2]), 0), 95, 'the durations add up to the figure on the page');

    const k = await download(page, 'Export tasks');
    const taskRows = parseCsv(k.text.slice(1));
    assert.equal(taskRows.length - 1, 3);
    assert.deepEqual(taskRows.slice(1).map((r) => r[4]), ['Yes', 'No', 'No']);
  });

  await step('P11', 'Exports follow the chosen period and subject', async () => {
    await go();
    await pickPeriod('All time');
    await expectFigures(page, { 'study-time': 'Study time 3 h 15 min 4 sessions on 4 days' });
    assert.equal(parseCsv((await download(page, 'Export study sessions')).text.slice(1)).length - 1, 4);
    await page.locator('#report-subject').selectOption({ label: N('History') });
    await expectFigures(page, { 'study-time': 'Study time 20 min 1 session on 1 day' });
    const rows = parseCsv((await download(page, 'Export study sessions')).text.slice(1));
    assert.equal(rows.length - 1, 1);
    assert.equal(rows[1][3], N('History'));
  });

  await step('P12', 'Awkward and hostile text survives the export exactly; formulas are neutralized', async () => {
    const awkward = ['comma, inside', 'quote " inside', 'two\nlines', '=HYPERLINK("http://evil.example","click")', '+1+1', '-2+3', '@SUM(1+1)', 'Zoë 学习'];
    for (const [i, description] of awkward.entries()) await mk('/assignments', { title: N(`awkward ${String(i).padStart(2, '0')}`), dueDate: ymd(-2), description });
    await go();
    const rows = parseCsv((await download(page, 'Export assignments')).text.slice(1)).slice(1).filter((r) => r[0].includes('awkward'));
    rows.sort((x, y) => x[0].localeCompare(y[0]));
    assert.equal(rows.length, awkward.length);
    for (const [i, expected] of awkward.entries()) {
      const wanted = /^[=+\-@]/.test(expected) ? `'${expected}` : expected;
      assert.equal(rows[i][9], wanted, JSON.stringify(expected));
      assert.equal(rows[i].length, 10, 'no extra columns');
    }
  });

  await step('P13', 'Export errors show a message and leave the page working', { provoked: true }, async () => {
    await page.route(EXPORT_URL, (route) => route.fulfill(json(400, 'This export has more than 10000 rows. Choose a shorter date range.')));
    await go();
    await page.getByRole('button', { name: 'Export tasks', exact: true }).click();
    await page.getByRole('alert').getByText('This export has more than 10000 rows').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Export tasks', exact: true }).isEnabled(), true, 'the button is usable again');
    await page.unroute(EXPORT_URL);
    await page.route(EXPORT_URL, (route) => route.abort('failed'));
    await page.getByRole('button', { name: 'Export tasks', exact: true }).click();
    await page.getByRole('alert').getByText('Cannot reach the StudyFlow server').waitFor();
    await page.unroute(EXPORT_URL);
    assert.equal((await download(page, 'Export tasks')).filename, `studyflow-tasks-${today}.csv`, 'and a later export works');
  });

  await step('P14', 'Server error on the report: a clear message and a working "Try again"', { provoked: true }, async () => {
    await page.route(SUMMARY_URL, (route) => route.fulfill(json(500, 'Something went wrong on the server.')));
    await page.goto(`${app}/reports`);
    await page.getByRole('alert').getByText('Something went wrong on the server.').waitFor();
    assert.equal(await page.getByRole('region', { name: 'Report figures' }).count(), 0, 'no half-drawn figures next to an error');
    await page.unroute(SUMMARY_URL);
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('region', { name: 'Report figures' }).waitFor();
  });

  await step('P15', 'Accessibility: labelled controls, text descriptions for charts, keyboard export', async () => {
    await go();
    assert.equal(await page.locator('h1').count(), 1);
    for (const id of ['report-period', 'report-subject']) assert.ok(await page.locator(`label[for="${id}"]`).count() === 1, `${id} has a label`);
    for (const chart of await page.locator('.chart-box').all()) assert.ok((await chart.getAttribute('aria-label')).length > 20);
    for (const heading of ['Study time by day', 'Assignments by status', 'Study time by subject', 'Export to CSV']) await page.getByRole('heading', { name: heading, level: 2 }).waitFor();
    await page.getByRole('button', { name: 'Export tasks', exact: true }).focus();
    const [file] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    assert.match(file.suggestedFilename(), /^studyflow-tasks-/);
  });

  await step('P16', 'Phone width: no horizontal scrolling and charts fit', async () => {
    const phone = await t.newPage({ viewport: { width: 375, height: 812 } });
    await go('/reports', phone);
    await phone.getByRole('img', { name: /Study minutes by day/ }).waitFor();
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `the page is ${overflow}px wider than the screen`);
    await pickPeriod('Custom range', phone);
    const customOverflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(customOverflow <= 0);
    await shot(phone, 'reports-03-phone');
    await phone.context().close();
  });

  await step('P17', 'Hostile subject names are plain text in the report', async () => {
    const evil = await mk('/subjects', { name: N('<img src=x onerror=alert(1)>') });
    await makeSession(evil, ymd(-1), 12);
    let dialogs = 0;
    page.on('dialog', async (dialog) => { dialogs += 1; await dialog.dismiss(); });
    await go();
    await page.getByRole('list', { name: 'Study time by subject' }).getByText('<img src=x', { exact: false }).waitFor();
    assert.equal(await page.locator('img[src="x"]').count(), 0);
    assert.equal(dialogs, 0);
  });

  for (const [id, timezoneId] of [['P18', 'Pacific/Kiritimati'], ['P19', 'Pacific/Pago_Pago']]) {
    await step(id, `"Last 30 days" follows the browser's own clock (${timezoneId})`, async () => {
      await clearAll();
      const zoneToday = new Date().toLocaleDateString('en-CA', { timeZone: timezoneId });
      await makeSession(seeded.maths, zoneToday, 17);
      await makeSession(seeded.maths, dayBefore(zoneToday), 11);
      const zonePage = await t.newPage({ timezoneId });
      await go('/reports', zonePage);
      await expectFigures(zonePage, { 'study-time': 'Study time 28 min 2 sessions on 2 days' });
      await zonePage.context().close();
    });
  }

  await clearAll();
}
