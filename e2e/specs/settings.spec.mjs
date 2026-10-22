import assert from 'node:assert/strict';
import { eventually, ymd } from '../lib/helpers.mjs';

export const name = 'Settings page';

const KEY = 'studyflow.settings.v1';
const DEFAULTS = { weekStart: 'monday', dateFormat: 'auto', timeFormat: 'auto' };

const addDays = (dateString, days) => {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
// The week that contains today, for a week starting on Monday or Sunday (the same rule the app uses).
const weekOf = (weekStart) => {
  const weekday = new Date().getDay();
  const since = weekStart === 'sunday' ? weekday : (weekday + 6) % 7;
  const from = ymd(-since);
  return { from, to: addDays(from, 6) };
};
const fmt = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

export default async function run(t) {
  const { app, db, N, tag, step, shot, api } = t;
  const page = await t.newPage();
  const col = db.col;

  // ---------- helpers ----------
  const go = async (path = '/settings', p = page) => {
    await p.goto(`${app}${path}`);
    await p.getByRole('heading', { level: 1 }).first().waitFor();
  };
  const stored = (p = page) => p.evaluate((key) => localStorage.getItem(key), KEY);
  const setStored = (value, p = page) => p.evaluate(([key, v]) => localStorage.setItem(key, v), [KEY, value]);
  const mk = async (route, body) => {
    const res = await api('POST', route, body);
    assert.equal(res.status, 201, `${route}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const choose = (label, p = page) => p.getByRole('radio', { name: label, exact: true }).check();
  async function storedMinutes({ from, to }) {
    const rows = await col('studysessions').find({ notes: { $regex: `^${tag}_`, $options: 'i' } }).toArray();
    return rows.filter((r) => r.date >= from && r.date <= to).reduce((sum, r) => sum + r.durationMinutes, 0);
  }
  // The same formatting the browser itself would do, so the test never hard-codes a language's wording.
  const browserDate = (dateString, locale, p = page) =>
    p.evaluate(([value, loc]) => {
      const [y, m, d] = value.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    }, [dateString, locale]);
  const browserTime = (locale, options, p = page) =>
    p.evaluate(([loc, opts]) => new Date(2000, 0, 1, 14, 30).toLocaleTimeString(loc, opts), [locale, options]);

  // ---------- defaults, saving, reloading ----------
  await step('G1', 'Defaults: Monday, browser date and time formats, a preview, and nothing saved yet', async () => {
    await go();
    assert.equal(await page.getByRole('radio', { name: 'Monday', exact: true }).isChecked(), true);
    assert.equal(await page.getByRole('radio', { name: 'Sunday', exact: true }).isChecked(), false);
    assert.equal(await page.locator('#setting-dateFormat').inputValue(), 'auto');
    assert.equal(await page.locator('#setting-timeFormat').inputValue(), 'auto');
    assert.match(await page.getByTestId('settings-preview').innerText(), /Preview:.+at/);
    assert.equal(await stored(), null, 'nothing is written until a setting is changed');
    await page.getByText('saved only in this browser', { exact: false }).waitFor();
    await shot(page, 'settings-01-defaults');
  });

  await step('G2', 'A change is saved at once, survives a reload, and only known keys are written', async () => {
    await choose('Sunday');
    await page.getByRole('status').getByText('Saved in this browser.').waitFor();
    assert.deepEqual(JSON.parse(await stored()), { ...DEFAULTS, weekStart: 'sunday' });
    await page.reload();
    await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
    assert.equal(await page.getByRole('radio', { name: 'Sunday', exact: true }).isChecked(), true);
    await page.locator('#setting-timeFormat').selectOption('24h');
    await page.locator('#setting-dateFormat').selectOption('iso');
    assert.deepEqual(JSON.parse(await stored()), { weekStart: 'sunday', dateFormat: 'iso', timeFormat: '24h' });
  });

  await step('G3', 'The preview and the other pages follow the chosen date and time formats', async () => {
    const assignment = await mk('/assignments', { title: N('Sample'), dueDate: ymd(1), dueTime: '14:30' });
    const dueText = async () => (await page.locator('li.assignment-card', { hasText: assignment.title }).getByText(/at /).first().innerText()).trim();
    const gotoAssignments = async () => { await go('/assignments'); await page.locator('li.assignment-card', { hasText: assignment.title }).waitFor(); };

    // ISO + 24-hour (still selected from G2)
    await go();
    assert.equal(await page.getByTestId('settings-preview').innerText(), `Preview: ${ymd(0)} at 14:30`);
    await gotoAssignments();
    assert.equal(await dueText(), `${ymd(1)} at 14:30`);

    await go();
    await page.locator('#setting-dateFormat').selectOption('day-first');
    await page.locator('#setting-timeFormat').selectOption('12h');
    await gotoAssignments();
    assert.equal(await dueText(), `${await browserDate(ymd(1), 'en-GB')} at ${await browserTime('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`);

    await go();
    await page.locator('#setting-dateFormat').selectOption('month-first');
    await gotoAssignments();
    assert.equal(await dueText(), `${await browserDate(ymd(1), 'en-US')} at ${await browserTime('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`);

    await go();
    await page.locator('#setting-dateFormat').selectOption('auto');
    await page.locator('#setting-timeFormat').selectOption('auto');
    await gotoAssignments();
    assert.equal(await dueText(), `${await browserDate(ymd(1), undefined)} at ${await browserTime(undefined, { hour: 'numeric', minute: '2-digit' })}`);
  });

  // ---------- the week-start setting, end to end ----------
  await step('G4', 'Week start Monday vs Sunday: dashboard, study sessions, reports and calendar all agree with the database', async () => {
    const subject = await mk('/subjects', { name: N('Weekly'), color: '#2563eb' });
    // distinct powers of two: every possible set of days adds up to a different total
    for (let k = 0; k <= 8; k += 1) await mk('/study-sessions', { subject: subject.id, date: ymd(-k), durationMinutes: 2 ** k, notes: N(`day ${k}`) });

    for (const weekStart of ['monday', 'sunday']) {
      await go();
      await choose(weekStart === 'monday' ? 'Monday' : 'Sunday');
      const week = weekOf(weekStart);
      const minutes = await storedMinutes(week);
      const text = fmt(minutes);

      // dashboard (the browser sends weekStart; the server calculates the week)
      const request = page.waitForRequest((r) => r.url().includes('/api/dashboard/stats'));
      await go('/');
      assert.match((await request).url(), new RegExp(`weekStart=${weekStart}`));
      await page.getByRole('region', { name: 'Summary' }).waitFor();
      await eventually(async () => (await page.getByTestId('stat-study-this-week').innerText()).trim() === text, `dashboard week ${text} (${weekStart})`);
      await page.getByText(`${await browserDate(week.from, undefined)} - ${await browserDate(week.to, undefined)}`).waitFor();

      // study sessions page
      await go('/study-sessions');
      await eventually(async () => (await page.getByTestId('total-week').innerText()).trim() === text, `sessions week ${text} (${weekStart})`);

      // reports "This week"
      await go('/reports');
      await page.locator('#report-period').selectOption({ label: 'This week' });
      await eventually(async () => (await page.getByTestId('figure-study-time').innerText()).replace(/\s+/g, ' ').startsWith(`Study time ${text} `), `reports week ${text} (${weekStart})`);

      // calendar: header order, first column, week view
      await go('/calendar');
      await page.locator('table.cal-grid').waitFor();
      const headers = await page.locator('table.cal-grid thead th').allInnerTexts();
      assert.equal(headers[0], weekStart === 'monday' ? 'Mon' : 'Sun');
      assert.equal(headers.length, 7);
      const firstCell = await page.locator('table.cal-grid tbody tr').first().locator('td').first().getAttribute('data-date');
      const [y, m, d] = firstCell.split('-').map(Number);
      assert.equal(new Date(y, m - 1, d).getDay(), weekStart === 'monday' ? 1 : 0, 'the month grid starts on the chosen weekday');
      await page.getByRole('button', { name: 'Week', exact: true }).click();
      const days = await page.locator('li.cal-week-day').evaluateAll((items) => items.map((item) => item.getAttribute('data-date')));
      assert.equal(days[0], week.from);
      assert.equal(days[6], week.to);
    }
    assert.notDeepEqual(weekOf('monday'), weekOf('sunday'), 'the two settings really give different weeks');
  });

  await step('G5', 'Reset to defaults clears what was saved', async () => {
    await go();
    await page.locator('#setting-dateFormat').selectOption('iso');
    assert.notEqual(await stored(), null);
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    await page.getByRole('status').getByText('Settings reset to the defaults.').waitFor();
    assert.equal(await stored(), null);
    assert.equal(await page.getByRole('radio', { name: 'Monday', exact: true }).isChecked(), true);
    assert.equal(await page.locator('#setting-dateFormat').inputValue(), 'auto');
    assert.equal(await page.locator('#setting-timeFormat').inputValue(), 'auto');
  });

  // ---------- damaged or hostile stored values ----------
  await step('G6', 'Damaged saved settings fall back to the defaults without breaking any page', async () => {
    const cases = [
      ['not json{', DEFAULTS],
      ['null', DEFAULTS],
      ['[]', DEFAULTS],
      ['"sunday"', DEFAULTS],
      ['{"weekStart":"friday","dateFormat":"x","timeFormat":5,"extra":1}', DEFAULTS],
      ['{"weekStart":"sunday","dateFormat":"nope"}', { ...DEFAULTS, weekStart: 'sunday' }],
      ['{"__proto__":{"weekStart":"sunday"},"timeFormat":"24h"}', { ...DEFAULTS, timeFormat: '24h' }],
      ['{"weekStart":{"$ne":1},"dateFormat":["iso"]}', DEFAULTS],
    ];
    for (const [value, expected] of cases) {
      await go();
      await setStored(value);
      for (const path of ['/settings', '/', '/calendar', '/reports', '/study-sessions']) {
        await go(path);
        await page.getByRole('heading', { level: 1 }).first().waitFor();
        assert.equal(await page.getByText('Something went wrong').count(), 0, `${path} with ${value}`);
      }
      await go();
      assert.equal(await page.getByRole('radio', { name: expected.weekStart === 'sunday' ? 'Sunday' : 'Monday', exact: true }).isChecked(), true, value);
      assert.equal(await page.locator('#setting-dateFormat').inputValue(), expected.dateFormat, value);
      assert.equal(await page.locator('#setting-timeFormat').inputValue(), expected.timeFormat, value);
    }
    await page.evaluate((key) => localStorage.removeItem(key), KEY);
  });

  await step('G7', 'Settings are validated when saved: an unknown value cannot be stored', async () => {
    await go();
    await page.evaluate(() => {
      const select = document.querySelector('#setting-dateFormat');
      const option = document.createElement('option');
      option.value = 'weird';
      option.textContent = 'weird';
      select.append(option);
    });
    await page.locator('#setting-dateFormat').selectOption('weird');
    assert.equal(JSON.parse(await stored()).dateFormat, 'auto', 'an unknown value is replaced by the default, not stored');
    await page.evaluate((key) => localStorage.removeItem(key), KEY);
  });

  await step('G8', 'Browser storage blocked: a clear message, and the setting still applies until the page is closed', async () => {
    const blocked = await t.newPage();
    await blocked.addInitScript(() => {
      const block = () => { throw new DOMException('blocked', 'SecurityError'); };
      Object.defineProperty(window, 'localStorage', { get: block });
    });
    await go('/settings', blocked);
    assert.equal(await blocked.getByRole('radio', { name: 'Monday', exact: true }).isChecked(), true, 'defaults are used');
    await blocked.getByRole('radio', { name: 'Sunday', exact: true }).check();
    await blocked.getByRole('alert').getByText('Your browser blocked saving').waitFor();
    // still applied while the page stays open (client-side navigation keeps the in-memory setting)
    await blocked.getByRole('link', { name: 'Calendar' }).first().click();
    await blocked.locator('table.cal-grid').waitFor();
    assert.equal((await blocked.locator('table.cal-grid thead th').first().innerText()), 'Sun');
    await blocked.context().close();
  });

  await step('G9', 'Accessibility: grouped radios with a legend, labelled selects, arrow keys change and save', async () => {
    await go();
    await page.getByRole('group', { name: 'Week starts on' }).waitFor();
    assert.equal(await page.locator('label[for="setting-dateFormat"]').count(), 1);
    assert.equal(await page.locator('label[for="setting-timeFormat"]').count(), 1);
    await page.getByRole('radio', { name: 'Monday', exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByRole('radio', { name: 'Sunday', exact: true }).isChecked(), true);
    assert.equal(JSON.parse(await stored()).weekStart, 'sunday');
    await page.getByRole('button', { name: 'Reset to defaults' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await stored(), null);
    assert.equal(await page.locator('h1').count(), 1);
  });

  await step('G10', 'Phone width: no horizontal scrolling', async () => {
    const phone = await t.newPage({ viewport: { width: 375, height: 812 } });
    await go('/settings', phone);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `the page is ${overflow}px wider than the screen`);
    await shot(phone, 'settings-02-phone');
    await phone.context().close();
  });

  await step('G11', 'Settings never reach the server (no account, nothing stored in the database)', async () => {
    const requests = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/')) requests.push(`${r.method()} ${r.url()}`); });
    await go();
    await choose('Sunday');
    await page.locator('#setting-timeFormat').selectOption('24h');
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    assert.deepEqual(requests, [], 'changing settings sends no write request to the API');
  });

  for (const [id, timezoneId] of [['G12', 'Pacific/Kiritimati']]) {
    await step(id, `Sunday-start "this week" in a distant time zone (${timezoneId}) matches that zone's own calendar`, async () => {
      const zonePage = await t.newPage({ timezoneId });
      await go('/settings', zonePage);
      await zonePage.getByRole('radio', { name: 'Sunday', exact: true }).check();
      await go('/calendar', zonePage);
      await zonePage.locator('table.cal-grid').waitFor();
      const zoneToday = new Date().toLocaleDateString('en-CA', { timeZone: timezoneId });
      assert.equal(await zonePage.locator('td.cal-today').getAttribute('data-date'), zoneToday);
      assert.equal((await zonePage.locator('table.cal-grid thead th').first().innerText()), 'Sun');
      await zonePage.context().close();
    });
  }
}
