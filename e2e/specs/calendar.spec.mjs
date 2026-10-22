import assert from 'node:assert/strict';
import { eventually, pad, sleep, ymd } from '../lib/helpers.mjs';

export const name = 'Calendar page';

const monthName = (year, month) => new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const mondayOfThisWeek = () => ymd(-((new Date().getDay() + 6) % 7));
// The 15th of next month (always a different month from today), as YYYY-MM-DD plus its month title.
function nextMonth15() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 15);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-15`, title: monthName(d.getFullYear(), d.getMonth() + 1) };
}

export default async function run(t) {
  const { app, N, step, shot, api } = t;
  const page = await t.newPage();
  const CAL_URL = /\/api\/calendar(\?.*)?$/;
  const json500 = { status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Something went wrong on the server.' } }) };
  const today = ymd(0);
  const [ty, tm] = today.split('-').map(Number);
  const thisMonthTitle = monthName(ty, tm);

  // ---------- helpers ----------
  const go = async (path = '/calendar', p = page) => {
    await p.goto(`${app}${path}`);
    await p.getByRole('heading', { name: 'Calendar', level: 1 }).waitFor();
    await p.getByTestId('calendar-title').waitFor();
    await settled(p);
  };
  // Waits until the calendar has finished loading (the status text is gone).
  const settled = (p) => p.getByText('Loading calendar...').waitFor({ state: 'detached' });
  const title = (p = page) => p.getByTestId('calendar-title');
  const agenda = (p = page) => p.getByRole('list', { name: 'Events on the selected day' }).getByRole('button');
  const agendaItem = (name, p = page) => p.getByRole('list', { name: 'Events on the selected day' }).getByRole('button', { name });
  const expectTitle = (text) => eventually(async () => (await title().innerText()).trim() === text, `calendar title "${text}"`);
  const agendaTexts = async (p = page) => (await agenda(p).allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
  const mk = async (route, body) => {
    const res = await api('POST', route, body);
    assert.equal(res.status, 201, `${route}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  let noteCounter = 0;
  const makeSession = (subject, date, extra = {}) => {
    noteCounter += 1;
    return mk('/study-sessions', { subject: subject.id, date, durationMinutes: 30, notes: N(`note ${noteCounter}`), ...extra });
  };
  async function clearAll() {
    for (const route of ['/study-sessions', '/tasks', '/assignments']) {
      const { body } = await api('GET', `${route}?limit=200`);
      await Promise.all(body.data.map((row) => api('DELETE', `${route}/${row.id}`)));
    }
  }
  const expectAgenda = async (expected, p = page) => {
    let actual = [];
    await eventually(async () => {
      actual = await agendaTexts(p);
      return actual.length === expected.length && expected.every((part, i) => actual[i].includes(part));
    }, `agenda ${JSON.stringify(expected)}`).catch((error) => { throw new Error(`${error.message}; last seen: ${JSON.stringify(actual)}`); });
  };

  const data = {};

  // ---------- empty ----------
  await step('K1', 'Loading state, then an empty month with today highlighted and a clear "nothing scheduled" message', async () => {
    await page.route(CAL_URL, async (route) => {
      await sleep(1500);
      try { await route.continue(); } catch { /* page already moved on */ }
    });
    await page.goto(`${app}/calendar`);
    await page.getByText('Loading calendar...').waitFor({ timeout: 1200 });
    await settled(page);
    await page.unroute(CAL_URL);
    assert.equal((await title().innerText()).trim(), thisMonthTitle);
    await page.getByText('Nothing is scheduled this month.').waitFor();
    assert.equal(await page.locator('td.cal-today').getAttribute('data-date'), today);
    assert.equal(await page.locator('.cal-event').count(), 0);
    await page.getByText('Nothing is scheduled for this day.').waitFor();
    const weeks = await page.locator('table.cal-grid tbody tr').count();
    assert.ok(weeks >= 4 && weeks <= 6, `${weeks} week rows`);
    assert.equal(await page.locator('table.cal-grid thead th').allInnerTexts().then((x) => x.join(',')), 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', 'weeks start on Monday');
    await shot(page, 'calendar-01-empty');
  });

  // ---------- events ----------
  await step('K2', 'Every kind of event appears on its day, labelled in words (deadline, task, planned vs recorded study)', async () => {
    data.maths = await mk('/subjects', { name: N('Maths'), color: '#2563eb' });
    data.history = await mk('/subjects', { name: N('History'), color: '#dc2626' });
    data.assignment = await mk('/assignments', { title: N('Essay'), dueDate: today, subject: data.maths.id });
    data.task1 = await mk('/tasks', { title: N('Revise'), date: today, subject: data.maths.id });
    data.task2 = await mk('/tasks', { title: N('Loose task'), date: today });
    data.recorded = await makeSession(data.maths, today, { startTime: '00:00' });
    data.planned = await makeSession(data.maths, today, { startTime: '23:59' });
    data.historySession = await makeSession(data.history, today);

    await go();
    await page.locator(`td[data-date="${today}"] .cal-event`).first().waitFor();
    const chips = (await page.locator(`td[data-date="${today}"] .cal-event`).allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
    assert.equal(chips.length, 3, 'a day cell shows at most 3 events');
    await page.locator(`td[data-date="${today}"]`).getByRole('button', { name: '+3 more' }).waitFor();

    await expectAgenda([`Studied: ${N('Maths')} (30 min)`, `Planned study: ${N('Maths')} (30 min)`, `Due: ${N('Essay')}`, `Task: ${N('Revise')}`, `Task: ${N('Loose task')}`, `Studied: ${N('History')} (30 min)`]);
    const texts = await agendaTexts();
    assert.ok(texts[0].startsWith('12:00 AM'), 'timed events show their time, earliest first');
    assert.ok(texts[1].startsWith('11:59 PM'));
    assert.ok(!/^\d/.test(texts[2]), 'events without a time come after the timed ones');
    await page.getByRole('heading', { name: new RegExp('\\(today\\)') }).waitFor();
    assert.equal(await page.getByText('Nothing is scheduled this month.').count(), 0);
    await shot(page, 'calendar-02-events');
  });

  await step('K3', 'Clicking "+3 more" or a day selects it and lists every event of that day', async () => {
    await go();
    await page.locator(`td[data-date="${today}"]`).getByRole('button', { name: '+3 more' }).click();
    assert.equal((await agenda().count()), 6);
    const otherDay = ymd(0) === `${ty}-${pad(tm)}-01` ? `${ty}-${pad(tm)}-02` : `${ty}-${pad(tm)}-01`;
    await page.locator(`td[data-date="${otherDay}"] .cal-day`).click();
    await page.getByText('Nothing is scheduled for this day.').waitFor();
    assert.equal(await page.locator(`td[data-date="${otherDay}"] .cal-day`).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: new RegExp(`\\(today\\), 6 events`) }).click();
    assert.equal((await agenda().count()), 6);
  });

  await step('K4', 'Event details dialog: planned vs recorded, subject, status; Esc closes it and focus returns', async () => {
    await go();
    await agendaItem(`Due: ${N('Essay')}`).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: N('Essay') }).waitFor();
    await dialog.getByText('Assignment deadline').waitFor();
    await dialog.getByText(N('Maths')).waitFor();
    await dialog.getByText('Not Started').waitFor();
    await dialog.getByText('Medium').waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('Due:')), true, 'focus returns to the event that was opened');

    await agendaItem(new RegExp(`^11:59 PM Planned study: ${N('Maths')}`)).click();
    await dialog.getByText('Study session - planned').waitFor();
    await dialog.getByText('30 min', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'hidden' });

    await agendaItem(new RegExp(`^12:00 AM Studied: ${N('Maths')}`)).click();
    await dialog.getByText('Study session - recorded').waitFor();
    await page.keyboard.press('Escape');

    await agendaItem(`Task: ${N('Loose task')}`).click();
    await dialog.getByText('No subject').waitFor();
    await dialog.getByText('Done').first().waitFor();
    await shot(page, 'calendar-03-dialog');
    await page.keyboard.press('Escape');
  });

  await step('K5', 'Each event links to its record: "Open in ..." opens the edit form with the right data', async () => {
    await go();
    await agendaItem(`Due: ${N('Essay')}`).click();
    await page.getByRole('link', { name: 'Open in Assignments' }).click();
    await page.getByRole('heading', { name: 'Edit assignment' }).waitFor();
    assert.equal(await page.locator('#assignment-title').inputValue(), N('Essay'));
    assert.equal(new URL(page.url()).search, '', 'the one-time link is removed from the address');

    await go();
    await agendaItem(`Task: ${N('Revise')}`).click();
    await page.getByRole('link', { name: 'Open in Tasks' }).click();
    await page.getByRole('heading', { name: 'Edit task' }).waitFor();
    assert.equal(await page.locator('#task-title').inputValue(), N('Revise'));

    await go();
    await agendaItem(new RegExp(`Planned study: ${N('Maths')}`)).click();
    await page.getByRole('link', { name: 'Open in Study sessions' }).click();
    await page.getByRole('heading', { name: 'Edit study session' }).waitFor();
    assert.equal(await page.locator('#session-startTime').inputValue(), '23:59');

    // Back to the calendar after editing: the page still works.
    await page.getByRole('link', { name: 'Calendar' }).first().click();
    await page.getByTestId('calendar-title').waitFor();
  });

  await step('K6', 'Kind toggles hide and show events; with none selected there is a clear message', async () => {
    await go();
    const kinds = { tasks: page.getByRole('checkbox', { name: 'Tasks' }), sessions: page.getByRole('checkbox', { name: 'Study sessions' }), assignments: page.getByRole('checkbox', { name: 'Assignment deadlines' }) };
    await kinds.tasks.uncheck();
    await expectAgenda([`Studied: ${N('Maths')}`, `Planned study: ${N('Maths')}`, `Due: ${N('Essay')}`, `Studied: ${N('History')}`]);
    await kinds.sessions.uncheck();
    await expectAgenda([`Due: ${N('Essay')}`]);
    await kinds.assignments.uncheck();
    await page.getByText('Choose at least one kind of event to show.').waitFor();
    assert.equal(await page.locator('.cal-event').count(), 0);
    await kinds.tasks.check();
    await expectAgenda([`Task: ${N('Revise')}`, `Task: ${N('Loose task')}`]);
    await kinds.sessions.check();
    await kinds.assignments.check();
    await expectAgenda([`Studied: ${N('Maths')}`, `Planned study: ${N('Maths')}`, `Due: ${N('Essay')}`, `Task: ${N('Revise')}`, `Task: ${N('Loose task')}`, `Studied: ${N('History')}`]);
  });

  await step('K7', 'Subject filter: that subject\'s deadlines, tasks and sessions only', async () => {
    await go();
    await page.locator('#calendar-subject').selectOption({ label: N('History') });
    await expectAgenda([`Studied: ${N('History')}`]);
    await page.locator('#calendar-subject').selectOption({ label: N('Maths') });
    await expectAgenda([`Studied: ${N('Maths')}`, `Planned study: ${N('Maths')}`, `Due: ${N('Essay')}`, `Task: ${N('Revise')}`]);
    await page.locator('#calendar-subject').selectOption('');
    await expectAgenda([`Studied: ${N('Maths')}`, `Planned study: ${N('Maths')}`, `Due: ${N('Essay')}`, `Task: ${N('Revise')}`, `Task: ${N('Loose task')}`, `Studied: ${N('History')}`]);
  });

  await step('K8', 'Month navigation: next / previous / today, with events on other months', async () => {
    const later = nextMonth15();
    data.laterTask = await mk('/tasks', { title: N('Next month task'), date: later.date });
    await go();
    await page.getByRole('button', { name: /^Next/ }).click();
    await expectTitle(later.title);
    await page.locator(`td[data-date="${later.date}"] .cal-event`).filter({ hasText: N('Next month task') }).waitFor();
    assert.equal(await page.locator('td.cal-today').count(), 0, 'today is not in the next month');
    await page.getByRole('button', { name: /^Previous/ }).click();
    await expectTitle(thisMonthTitle);
    await page.getByRole('button', { name: /^Next/ }).click();
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expectTitle(thisMonthTitle);
    await expectAgenda([`Studied: ${N('Maths')}`, `Planned study: ${N('Maths')}`, `Due: ${N('Essay')}`, `Task: ${N('Revise')}`, `Task: ${N('Loose task')}`, `Studied: ${N('History')}`]);
    // Previous x 14 and Next x 14 land back on the same month (month-end days such as the 31st never skip a month)
    for (let i = 0; i < 14; i += 1) await page.getByRole('button', { name: /^Previous/ }).click();
    for (let i = 0; i < 14; i += 1) await page.getByRole('button', { name: /^Next/ }).click();
    await expectTitle(thisMonthTitle);
  });

  await step('K9', 'Week view: seven days from Monday, events listed in full; week navigation', async () => {
    await go();
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Week', exact: true }).getAttribute('aria-pressed'), 'true');
    const days = await page.locator('li.cal-week-day').evaluateAll((items) => items.map((item) => item.getAttribute('data-date')));
    assert.equal(days.length, 7);
    assert.equal(days[0], mondayOfThisWeek(), 'the week starts on Monday');
    const todayCard = page.locator(`li.cal-week-day[data-date="${today}"]`);
    await todayCard.getByRole('button', { name: `Due: ${N('Essay')}` }).waitFor();
    assert.equal(await todayCard.locator('.cal-event').count(), 6, 'a week day lists every event (no "+n more")');
    await todayCard.getByText('Today').waitFor();
    await page.getByRole('button', { name: /^Next/ }).click();
    const nextDays = await page.locator('li.cal-week-day').evaluateAll((items) => items.map((item) => item.getAttribute('data-date')));
    assert.equal(nextDays[0], ymd(7 - ((new Date().getDay() + 6) % 7)), 'the next week starts 7 days after');
    await eventually(async () => (await page.locator('li.cal-week-day .cal-event').count()) === 0, 'an empty next week');
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await page.locator(`li.cal-week-day[data-date="${today}"]`).getByRole('button', { name: `Due: ${N('Essay')}` }).waitFor();
    await shot(page, 'calendar-04-week');
  });

  await step('K10', 'The calendar follows changes made elsewhere: edit, complete, delete', async () => {
    assert.equal((await api('PUT', `/tasks/${data.task2.id}`, { title: data.task2.title, date: nextMonth15().date })).status, 200);
    assert.equal((await api('PATCH', `/tasks/${data.task1.id}/completed`, { completed: true })).status, 200);
    assert.equal((await api('DELETE', `/assignments/${data.assignment.id}`)).status, 200);
    await go();
    await expectAgenda([`Studied: ${N('Maths')}`, `Planned study: ${N('Maths')}`, `Task: ${N('Revise')} (done)`, `Studied: ${N('History')}`]);
    await agendaItem(`Task: ${N('Revise')} (done)`).click();
    await page.getByRole('dialog').getByText('Done').first().waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Next/ }).click();
    await page.locator('.cal-event').filter({ hasText: N('Loose task') }).first().waitFor();
  });

  await step('K11', 'Server error: a clear message and a working "Try again"', { provoked: true }, async () => {
    await page.route(CAL_URL, (route) => route.fulfill(json500));
    await page.goto(`${app}/calendar`);
    await page.getByRole('alert').getByText('Something went wrong on the server.').waitFor();
    assert.equal(await page.locator('.cal-event').count(), 0, 'no stale events next to an error');
    await page.unroute(CAL_URL);
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('alert').waitFor({ state: 'detached' });
    await page.locator(`td[data-date="${today}"] .cal-event`).first().waitFor();
  });

  await step('K12', 'Server unreachable: the "Cannot reach" message instead of a blank page', { provoked: true }, async () => {
    await page.route(CAL_URL, (route) => route.abort('failed'));
    await page.goto(`${app}/calendar`);
    await page.getByText('Cannot reach the StudyFlow server').waitFor();
    await page.unroute(CAL_URL);
  });

  await step('K13', 'Keyboard and screen reader: day buttons say how many events they hold; Enter opens an event; toggles are real buttons', async () => {
    await go();
    const dayButton = page.locator(`td[data-date="${today}"] .cal-day`);
    assert.match(await dayButton.getAttribute('aria-label'), /\(today\), 4 events$/);
    assert.equal(await page.getByRole('group', { name: 'Calendar view' }).getByRole('button').count(), 2);
    await page.getByRole('button', { name: /^Next/ }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /^Previous/ }).focus();
    await page.keyboard.press('Enter');
    await expectTitle(thisMonthTitle);
    const chip = page.locator(`td[data-date="${today}"] .cal-event`).first();
    await chip.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    assert.ok(await page.getByRole('dialog').getByRole('heading').count() >= 1, 'the dialog has a heading that names it');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('table.cal-grid caption').count(), 1, 'the grid has a caption');
    assert.equal(await page.locator('table.cal-grid th[scope="col"]').count(), 7);
  });

  await step('K14', 'Phone width: no horizontal scrolling; compact month grid with the full day list underneath', async () => {
    const phone = await t.newPage({ viewport: { width: 375, height: 812 } });
    await go('/calendar', phone);
    await phone.locator(`td[data-date="${today}"] .cal-event`).first().waitFor();
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `the page is ${overflow}px wider than the screen`);
    await phone.locator(`td[data-date="${today}"] .cal-day`).click();
    await expectAgenda([`Studied: ${N('Maths')}`, `Planned study: ${N('Maths')}`, `Task: ${N('Revise')} (done)`, `Studied: ${N('History')}`], phone);
    await shot(phone, 'calendar-05-phone');
    await phone.getByRole('button', { name: 'Week', exact: true }).click();
    await phone.locator(`li.cal-week-day[data-date="${today}"]`).waitFor();
    const weekOverflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(weekOverflow <= 0, `week view is ${weekOverflow}px wider than the screen`);
    await phone.context().close();
  });

  await step('K15', 'Hostile or very long titles are plain text and wrap inside their box', async () => {
    await mk('/assignments', { title: `<img src=x onerror="window.__pwned=1"> ${N('xss')}`, dueDate: today });
    await mk('/tasks', { title: `${N('long')} ${'W'.repeat(120)}`, date: today });
    let dialogs = 0;
    page.on('dialog', async (dialog) => { dialogs += 1; await dialog.dismiss(); });
    await go();
    await page.getByRole('button', { name: new RegExp(N('xss')) }).first().waitFor();
    assert.equal(await page.locator('img[src="x"]').count(), 0);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    assert.equal(dialogs, 0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `the page is ${overflow}px wider than the screen`);
    await page.getByRole('button', { name: new RegExp(N('xss')) }).first().click();
    await page.getByRole('dialog').getByRole('heading', { name: /<img src=x/ }).waitFor();
    await page.keyboard.press('Escape');
  });

  await step('K16', 'Links to records that no longer exist give a clear message, not a blank form', { provoked: true }, async () => {
    await page.goto(`${app}/study-sessions?edit=64b7f0c2a1b2c3d4e5f60718`);
    await page.getByText('That study session could not be found').waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Edit study session' }).count(), 0);
    await page.goto(`${app}/tasks?edit=${data.task1.id}`);
    await page.getByRole('heading', { name: 'Edit task' }).waitFor();
    await page.reload(); // the link was used up: a refresh must NOT reopen the form
    await page.getByRole('heading', { name: 'Tasks', level: 1 }).waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('heading', { name: 'Edit task' }).count(), 0);
  });

  // ---------- time zones ----------
  for (const [id, timezoneId] of [['K17', 'Pacific/Kiritimati'], ['K18', 'Pacific/Pago_Pago']]) {
    await step(id, `"Today" follows the browser's own clock (${timezoneId})`, async () => {
      await clearAll();
      const zoneToday = new Date().toLocaleDateString('en-CA', { timeZone: timezoneId });
      await mk('/tasks', { title: N(`zone task ${timezoneId}`), date: zoneToday });
      const zonePage = await t.newPage({ timezoneId });
      await go('/calendar', zonePage);
      assert.equal(await zonePage.locator('td.cal-today').getAttribute('data-date'), zoneToday);
      await zonePage.locator(`td[data-date="${zoneToday}"] .cal-event`).filter({ hasText: N(`zone task ${timezoneId}`) }).waitFor();
      await zonePage.getByRole('heading', { name: /\(today\)/ }).waitFor();
      await zonePage.context().close();
    });
  }

  await clearAll();
}
