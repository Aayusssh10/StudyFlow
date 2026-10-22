import assert from 'node:assert/strict';
import { eventually, pad, sleep, ymd } from '../lib/helpers.mjs';

export const name = 'Study sessions page';

// 75 -> "1 h 15 min" (the same wording the page uses)
const fmt = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};
// Monday-to-Sunday week containing today, as the page defines it.
const thisWeek = () => {
  const sinceMonday = (new Date().getDay() + 6) % 7;
  return { from: ymd(-sinceMonday), to: ymd(6 - sinceMonday) };
};

export default async function run(t) {
  const { app, db, N, tag, step, shot, api } = t;
  const page = await t.newPage();
  const col = db.col;

  // ---------- helpers ----------
  const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const item = (subjectLabel, durationText) =>
    page.locator('li.session-item', { has: page.locator('h2', { hasText: exactly(N(subjectLabel)) }) }).filter({ hasText: durationText });
  const cardsShown = () => page.locator('li.session-item').count();
  const durationsShown = async () => (await page.locator('li.session-item .session-duration').allInnerTexts()).map((s) => s.trim());

  async function expectDurations(expected) {
    let actual = [];
    await eventually(async () => {
      actual = await durationsShown();
      return JSON.stringify(actual) === JSON.stringify(expected);
    }, `durations ${JSON.stringify(expected)}`).catch((error) => { throw new Error(`${error.message}; last seen: ${JSON.stringify(actual)}`); });
  }

  const go = async (url) => { await page.goto(url); await page.locator('#session-filter-q').waitFor(); await page.waitForLoadState('networkidle'); };
  const reload = async () => { await page.reload(); await page.locator('#session-filter-q').waitFor(); await page.waitForLoadState('networkidle'); };
  const text = (value) => page.getByText(value, { exact: false });
  const total = (which) => page.getByTestId(`total-${which}`);
  const LIST_URL = /\/api\/study-sessions(\?.*)?$/;
  const ITEM_URL = /\/api\/study-sessions\/[0-9a-f]{24}$/;
  const json500 = { status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Something went wrong on the server.' } }) };

  const apiSubject = async (label, fields = {}) => {
    const res = await api('POST', '/subjects', { name: N(label), ...fields });
    assert.equal(res.status, 201);
    return res.body.data;
  };
  const apiAssignment = async (label, fields = {}) => {
    const res = await api('POST', '/assignments', { title: N(label), dueDate: ymd(10), ...fields });
    assert.equal(res.status, 201);
    return res.body.data;
  };
  let noteCounter = 0;
  const apiSession = async (subject, fields = {}) => {
    noteCounter += 1;
    const res = await api('POST', '/study-sessions', { subject: subject.id, date: ymd(0), durationMinutes: 30, notes: N(`note ${noteCounter}`), ...fields });
    assert.equal(res.status, 201, `creating a session: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  async function clearSessions() {
    const { body } = await api('GET', '/study-sessions?limit=200');
    await Promise.all(body.data.map((s) => api('DELETE', `/study-sessions/${s.id}`)));
  }
  // Sums computed straight from the DATABASE, independently of what the page shows.
  async function storedMinutes(range) {
    const rows = await col('studysessions').find({ notes: { $regex: `^${tag}_`, $options: 'i' } }).toArray();
    const inRange = rows.filter((r) => (!range.from || r.date >= range.from) && (!range.to || r.date <= range.to));
    return { minutes: inRange.reduce((sum, r) => sum + r.durationMinutes, 0), count: inRange.length };
  }

  async function openForm() {
    await page.getByRole('button', { name: 'Add session', exact: true }).click();
    await page.getByRole('heading', { name: 'Add a study session' }).waitFor();
  }
  async function fillForm(f) {
    if (f.subject !== undefined) await page.locator('#session-subject').selectOption(f.subject);
    if (f.assignment !== undefined) await page.locator('#session-assignment').selectOption(f.assignment);
    if (f.date !== undefined) await page.locator('#session-date').fill(f.date);
    if (f.startTime !== undefined) await page.locator('#session-startTime').fill(f.startTime);
    if (f.durationMinutes !== undefined) await page.locator('#session-durationMinutes').fill(String(f.durationMinutes));
    if (f.type !== undefined) await page.locator('#session-type').selectOption(f.type);
    if (f.notes !== undefined) await page.locator('#session-notes').fill(f.notes);
  }
  const submitForm = (label) => page.getByRole('button', { name: label, exact: true }).click();

  // ---------- empty state, validation ----------
  await step('R1', 'Loading state, then the empty state with zero totals and a working "Add your first session" button', async () => {
    await page.route(LIST_URL, async (route) => {
      await sleep(1500);
      try { await route.continue(); } catch { /* page already moved on */ }
    });
    await page.goto(`${app}/study-sessions`);
    await text('Loading study sessions...').waitFor({ timeout: 1200 });
    await text('No study sessions yet').waitFor();
    await page.unroute(LIST_URL);
    assert.equal((await total('today').innerText()).trim(), '0 min', 'with no sessions the totals are zero, not blank or NaN');
    assert.equal((await total('week').innerText()).trim(), '0 min');
    assert.equal((await total('view').innerText()).trim(), '0 min');
    assert.equal(await page.getByRole('region', { name: 'Study time by subject' }).count(), 0, 'no breakdown is drawn for no data');
    await shot(page, 'sessions-01-empty');
    await page.getByRole('button', { name: 'Add your first session' }).click();
    await page.getByRole('heading', { name: 'Add a study session' }).waitFor();
    assert.equal(await page.locator('#session-date').inputValue(), ymd(0), 'a new session defaults to today');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('R2', 'The subject, date and duration are validated (blank, zero, too long, not a number); nothing is sent when invalid', async () => {
    let posts = 0;
    const count = (request) => { if (request.method() === 'POST') posts += 1; };
    page.on('request', count);
    await openForm();
    await page.locator('#session-date').fill('');
    await submitForm('Add session');
    await page.locator('#session-subject-error').waitFor();
    assert.equal(await page.locator('#session-subject-error').innerText(), 'Choose a subject.');
    assert.equal(await page.locator('#session-date-error').innerText(), 'Date is required.');
    assert.match(await page.locator('#session-durationMinutes-error').innerText(), /whole number of minutes from 1 to 1440/);
    assert.equal(await page.locator('#session-subject').getAttribute('aria-invalid'), 'true');
    const link = page.getByRole('link', { name: 'Add one on the Subjects page' });
    await link.waitFor();
    assert.match(await link.getAttribute('href'), /\/subjects$/);

    const subject = await apiSubject('First subject');
    await page.reload();
    await page.locator('#session-filter-q').waitFor();
    await openForm();
    await fillForm({ subject: subject.id, date: ymd(0) });
    for (const bad of ['0', '1441', '-5', '2.5', '']) {
      await fillForm({ durationMinutes: bad });
      await submitForm('Add session');
      await page.locator('#session-durationMinutes-error').waitFor();
      assert.match(await page.locator('#session-durationMinutes-error').innerText(), /from 1 to 1440/, `duration "${bad}"`);
    }
    page.off('request', count);
    assert.equal(posts, 0, 'no POST was sent for invalid input');
    assert.equal(await col('studysessions').countDocuments({}), 0);
    await shot(page, 'sessions-02-validation');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  // ---------- creating ----------
  let maths;
  let physics;
  let essay;
  await step('R3', 'A session can be created in the UI (subject, assignment, time, duration, type, notes); the card and the database agree', async () => {
    maths = await apiSubject('Maths');
    physics = await apiSubject('Physics');
    essay = await apiAssignment('Essay', { subject: physics.id });
    await go(`${app}/study-sessions`);

    await openForm();
    assert.deepEqual(await page.locator('#session-subject option').allInnerTexts(), ['Choose a subject...', N('First subject'), N('Maths'), N('Physics')], 'subjects are listed alphabetically');
    // choosing an assignment first fills in its subject (a shortcut), which can then still be changed
    await fillForm({ assignment: essay.id });
    assert.equal(await page.locator('#session-subject').inputValue(), physics.id, "the assignment's subject was filled in");
    await fillForm({ subject: maths.id, startTime: '14:30', durationMinutes: 90, type: 'Revision', notes: N('Chapter 3') });
    await submitForm('Add session');
    await text('Study session added.').waitFor();
    const c = item('Maths', '1 h 30 min');
    await c.waitFor();
    const cardText = await c.innerText();
    assert.match(cardText, /2:30\s?PM/);
    assert.match(cardText, /Revision/);
    assert.match(cardText, new RegExp(`For assignment: ${N('Essay')}`));
    await c.locator('summary', { hasText: 'Show notes' }).click();
    await text(N('Chapter 3')).waitFor();

    const row = await col('studysessions').findOne({ notes: N('Chapter 3') });
    assert.equal(row.subject.toString(), maths.id, 'the subject chosen last wins over the shortcut');
    assert.equal(row.assignment.toString(), essay.id);
    assert.equal(row.date, ymd(0), 'the date is saved exactly as shown (no time zone shift)');
    assert.equal(row.startTime, '14:30');
    assert.equal(row.durationMinutes, 90);
    assert.equal(row.type, 'Revision');
    await shot(page, 'sessions-03-created');
  });

  // ---------- totals ----------
  await step('R4', 'Today / this week / all-time totals and the by-subject list equal the sums of the stored sessions (checked against the database)', async () => {
    await clearSessions();
    await apiSession(maths, { date: ymd(0), durationMinutes: 45 });
    await apiSession(physics, { date: ymd(0), durationMinutes: 30 });
    await apiSession(maths, { date: ymd(-1), durationMinutes: 60 });
    await apiSession(maths, { date: ymd(-10), durationMinutes: 100 });
    await apiSession(physics, { date: ymd(-40), durationMinutes: 20 });
    await apiSession(physics, { date: ymd(30), durationMinutes: 15 }); // a planned (future) session
    // The edges of the week: this Monday is INSIDE it, the Sunday before is OUTSIDE it (so a wrong week start shows up).
    await apiSession(maths, { date: thisWeek().from, durationMinutes: 7 });
    await apiSession(maths, { date: ymd(-((new Date().getDay() + 6) % 7) - 1), durationMinutes: 9 });
    await reload();

    const todayExpected = await storedMinutes({ from: ymd(0), to: ymd(0) });
    const weekExpected = await storedMinutes(thisWeek());
    const allExpected = await storedMinutes({});
    assert.ok(todayExpected.minutes >= 75, 'the test data itself includes 45 + 30 today');
    await eventually(async () => (await total('today').innerText()).trim() === fmt(todayExpected.minutes), 'the today total');
    assert.equal((await total('week').innerText()).trim(), fmt(weekExpected.minutes), `this week (${thisWeek().from} to ${thisWeek().to})`);
    assert.equal((await total('view').innerText()).trim(), fmt(allExpected.minutes), 'all time');
    assert.match(await page.locator('.summary-card').first().innerText(), new RegExp(`${todayExpected.count} session`));

    // per-subject list, from the database
    const rows = await col('studysessions').find({ notes: { $regex: `^${tag}_`, $options: 'i' } }).toArray();
    const bySubject = (id) => rows.filter((r) => r.subject.toString() === id).reduce((sum, r) => sum + r.durationMinutes, 0);
    const breakdown = page.getByRole('region', { name: 'Study time by subject' });
    await breakdown.waitFor();
    assert.match(await breakdown.locator('li').nth(0).innerText(), new RegExp(`${N('Maths')}[\\s\\S]*${fmt(bySubject(maths.id)).replace(/ /g, '\\s')}`), 'the bigger subject is listed first with its total');
    assert.match(await breakdown.locator('li').nth(1).innerText(), new RegExp(`${N('Physics')}[\\s\\S]*${fmt(bySubject(physics.id)).replace(/ /g, '\\s')}`));
    await shot(page, 'sessions-04-totals');
  });

  await step('R5', 'Totals update by themselves after adding, editing and deleting a session', async () => {
    await clearSessions();
    await apiSession(maths, { durationMinutes: 40 });
    await reload();
    await eventually(async () => (await total('today').innerText()).trim() === '40 min', 'initial total');

    await openForm();
    await fillForm({ subject: physics.id, durationMinutes: 80, notes: N('Added in the UI') });
    await submitForm('Add session');
    await text('Study session added.').waitFor();
    await eventually(async () => (await total('today').innerText()).trim() === '2 h', '40 + 80 = 2 h after adding');
    assert.equal((await total('today').innerText()).trim(), fmt((await storedMinutes({ from: ymd(0), to: ymd(0) })).minutes));

    await item('Physics', '1 h 20 min').getByRole('button', { name: /^Edit/ }).click();
    await page.getByRole('heading', { name: 'Edit study session' }).waitFor();
    assert.equal(await page.locator('#session-durationMinutes').inputValue(), '80', 'the form is pre-filled');
    await fillForm({ durationMinutes: 20 });
    await submitForm('Save changes');
    await text('Study session updated.').waitFor();
    await eventually(async () => (await total('today').innerText()).trim() === '1 h', '40 + 20 = 1 h after editing');

    await item('Physics', '20 min').getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await text('Study session deleted.').waitFor();
    await eventually(async () => (await total('today').innerText()).trim() === '40 min', 'back to 40 min after deleting');
    assert.equal((await total('view').innerText()).trim(), fmt((await storedMinutes({})).minutes));
  });

  // ---------- edit and delete ----------
  await step('R6', 'Editing: change subject, assignment, date and notes; add and clear the assignment; persists after reload', async () => {
    await clearSessions();
    await apiSession(maths, { durationMinutes: 50, notes: N('Edit me'), date: ymd(-2) });
    await reload();
    await item('Maths', '50 min').getByRole('button', { name: /^Edit/ }).click();
    await page.getByRole('heading', { name: 'Edit study session' }).waitFor();
    assert.equal(await page.locator('#session-subject').inputValue(), maths.id);
    assert.equal(await page.locator('#session-date').inputValue(), ymd(-2));
    await fillForm({ subject: physics.id, assignment: essay.id, date: ymd(-3), notes: N('Edited notes'), durationMinutes: 55 });
    await submitForm('Save changes');
    await text('Study session updated.').waitFor();
    await reload();
    const c = item('Physics', '55 min');
    await c.waitFor();
    assert.match(await c.innerText(), new RegExp(`For assignment: ${N('Essay')}`));
    let row = await col('studysessions').findOne({ notes: N('Edited notes') });
    assert.equal(row.subject.toString(), physics.id);
    assert.equal(row.assignment.toString(), essay.id);
    assert.equal(row.date, ymd(-3));

    await c.getByRole('button', { name: /^Edit/ }).click();
    await fillForm({ assignment: '' });
    await submitForm('Save changes');
    await text('Study session updated.').waitFor();
    row = await col('studysessions').findOne({ notes: N('Edited notes') });
    assert.equal(row.assignment, null, 'the assignment link was cleared');
    assert.equal(row.subject.toString(), physics.id, 'the subject cannot be cleared and is kept');
  });

  await step('R7', 'Delete asks for confirmation; Cancel and Escape keep the session; Confirm deletes it', async () => {
    await clearSessions();
    await apiSession(maths, { durationMinutes: 11 });
    await apiSession(maths, { durationMinutes: 12 });
    await reload();
    const target = item('Maths', '11 min');
    const dialog = page.getByRole('dialog');
    await target.getByRole('button', { name: /^Delete/ }).click();
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /11 min session for/);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'focus starts on the safe button');
    await shot(page, 'sessions-05-delete-dialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await target.count(), 1);
    await target.getByRole('button', { name: /^Delete/ }).click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await col('studysessions').countDocuments({ durationMinutes: 11 }), 1);
    await target.getByRole('button', { name: /^Delete/ }).click();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await text('Study session deleted.').waitFor();
    await target.waitFor({ state: 'detached' });
    assert.equal(await col('studysessions').countDocuments({ durationMinutes: 11 }), 0);
    assert.equal(await col('studysessions').countDocuments({ durationMinutes: 12 }), 1, 'the other session is untouched');
  });

  // ---------- filters and sorting ----------
  await step('R8', 'Filters (subject, type, dates, notes search) change both the list and the "current filter" total; a no-match state; Clear filters', async () => {
    await clearSessions();
    await apiSession(maths, { date: ymd(-1), durationMinutes: 30, type: 'Reading', notes: N('maths reading') });
    await apiSession(maths, { date: ymd(-2), durationMinutes: 45, type: 'Practice', notes: N('maths practice') });
    await apiSession(physics, { date: ymd(-3), durationMinutes: 90, type: 'Revision', notes: N('physics revision') });
    await apiSession(physics, { date: ymd(-8), durationMinutes: 15, notes: N('physics old') });
    await reload();
    await expectDurations(['30 min', '45 min', '1 h 30 min', '15 min']);
    assert.equal((await total('view').innerText()).trim(), fmt(180), 'all time: 30+45+90+15');

    await page.locator('#session-filter-subject').selectOption(maths.id);
    await expectDurations(['30 min', '45 min']);
    await eventually(async () => (await total('view').innerText()).trim() === '1 h 15 min', 'the filtered total');
    assert.match(await page.locator('.summary-card').nth(2).innerText(), /In the current filter/);
    await page.locator('#session-filter-subject').selectOption('');
    await page.locator('#session-filter-type').selectOption('Revision');
    await expectDurations(['1 h 30 min']);
    await page.locator('#session-filter-type').selectOption('');
    await page.locator('#session-filter-from').fill(ymd(-3));
    await page.locator('#session-filter-to').fill(ymd(-2));
    await expectDurations(['45 min', '1 h 30 min']);
    await eventually(async () => (await total('view').innerText()).trim() === fmt(135), 'the date-range total');
    await page.locator('#session-filter-from').fill('');
    await page.locator('#session-filter-to').fill('');
    await page.locator('#session-filter-q').fill('PRACTICE');
    await expectDurations(['45 min']);
    await page.locator('#session-filter-q').fill('');
    await expectDurations(['30 min', '45 min', '1 h 30 min', '15 min']);

    await page.locator('#session-filter-subject').selectOption(maths.id);
    await page.locator('#session-filter-type').selectOption('Revision');
    await text('No study sessions match your filters').waitFor();
    assert.equal((await total('view').innerText()).trim(), '0 min', 'the filtered total is 0 when nothing matches');
    await shot(page, 'sessions-06-no-matches');
    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expectDurations(['30 min', '45 min', '1 h 30 min', '15 min']);
    assert.equal(await page.getByRole('button', { name: 'Clear filters' }).count(), 0);
  });

  await step('R9', 'Sorting: newest first by default; by duration; ascending/descending; changing the sort resets the order', async () => {
    await expectDurations(['30 min', '45 min', '1 h 30 min', '15 min']); // newest date first
    await page.locator('#session-filter-sort').selectOption('duration');
    await expectDurations(['1 h 30 min', '45 min', '30 min', '15 min']);
    await page.locator('#session-filter-order').selectOption('asc');
    await expectDurations(['15 min', '30 min', '45 min', '1 h 30 min']);
    await page.locator('#session-filter-sort').selectOption('date');
    assert.equal(await page.locator('#session-filter-order').inputValue(), '', 'a new sort goes back to its default order');
    await expectDurations(['30 min', '45 min', '1 h 30 min', '15 min']);
    await page.locator('#session-filter-order').selectOption('asc');
    await expectDurations(['15 min', '1 h 30 min', '45 min', '30 min']);
  });

  // ---------- integration ----------
  await step('R10', 'A subject with sessions cannot be deleted on the Subjects page; once its sessions are gone it can', { provoked: true }, async () => {
    await clearSessions();
    const subject = await apiSubject('Session subject');
    const one = await apiSession(subject, { durationMinutes: 20 });
    const two = await apiSession(subject, { durationMinutes: 25 });
    await page.goto(`${app}/subjects`);
    const subjectCard = page.locator('li.subject-card', { hasText: N('Session subject') });
    await subjectCard.waitFor();
    await subjectCard.getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Cannot delete' });
    await alert.waitFor();
    assert.match(await alert.innerText(), /still used by 2 study sessions/);
    assert.equal(await subjectCard.count(), 1);
    await api('DELETE', `/study-sessions/${one.id}`);
    await api('DELETE', `/study-sessions/${two.id}`);
    await page.reload();
    await subjectCard.waitFor();
    await subjectCard.getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await text(`Deleted "${N('Session subject')}".`).waitFor();
  });

  await step('R11', 'Deleting an assignment keeps its study sessions (and their time) and clears only the link', async () => {
    await clearSessions();
    const doomed = await apiAssignment('Doomed essay');
    await apiSession(maths, { durationMinutes: 35, assignment: doomed.id });
    await go(`${app}/study-sessions`);
    await eventually(async () => (await total('view').innerText()).trim() === '35 min', 'the total before');
    assert.match(await item('Maths', '35 min').innerText(), /For assignment/);

    await page.goto(`${app}/assignments`);
    await page.locator('#filter-q').waitFor();
    const assignmentCard = page.locator('li.assignment-card', { has: page.locator('h2.assignment-title', { hasText: exactly(N('Doomed essay')) }) });
    await assignmentCard.waitFor();
    await assignmentCard.getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await text(`Deleted "${N('Doomed essay')}".`).waitFor();

    await go(`${app}/study-sessions`);
    await eventually(async () => (await total('view').innerText()).trim() === '35 min', 'the total is unchanged');
    const c = item('Maths', '35 min');
    await c.waitFor();
    assert.doesNotMatch(await c.innerText(), /For assignment/, 'the link is gone');
    const row = await col('studysessions').findOne({ durationMinutes: 35, notes: { $regex: `^${tag}_` } });
    assert.equal(row.assignment, null);
    assert.equal(row.subject.toString(), maths.id, 'the subject (the study time) is intact');
  });

  await step('R12', 'A subject or assignment deleted elsewhere while the form is open: saving is refused, lists refresh, the stale id is not re-sent', { provoked: true }, async () => {
    await clearSessions();
    const [gone, goneAssignment] = [await apiSubject('Vanishing'), await apiAssignment('Vanishing essay')];
    await go(`${app}/study-sessions`);

    await openForm();
    await fillForm({ subject: gone.id, durationMinutes: 25, notes: N('stale subject') });
    assert.equal((await api('DELETE', `/subjects/${gone.id}`)).status, 200);
    await submitForm('Add session');
    await page.locator('#session-subject-error').waitFor();
    await page.getByRole('alert').filter({ hasText: 'does not exist' }).waitFor();
    assert.equal(await col('studysessions').countDocuments({ notes: N('stale subject') }), 0, 'nothing was saved');
    await eventually(async () => !(await page.locator('#session-subject option').allInnerTexts()).includes(N('Vanishing')), 'the subject list to refresh');
    assert.equal(await page.locator('#session-subject').inputValue(), '', 'the vanished choice is dropped');

    let posts = 0;
    const count = (request) => { if (request.method() === 'POST') posts += 1; };
    page.on('request', count);
    await submitForm('Add session');
    await eventually(async () => (await page.locator('#session-subject-error').innerText()) === 'Choose a subject.', 'the form to ask for a new subject');
    await sleep(300);
    page.off('request', count);
    assert.equal(posts, 0, 'the vanished subject id was not sent to the server again');

    await fillForm({ subject: maths.id });
    await submitForm('Add session');
    await text('Study session added.').waitFor();
    assert.equal((await col('studysessions').findOne({ notes: N('stale subject') })).subject.toString(), maths.id);

    await openForm();
    await fillForm({ subject: maths.id, assignment: goneAssignment.id, durationMinutes: 10, notes: N('stale assignment') });
    assert.equal((await api('DELETE', `/assignments/${goneAssignment.id}`)).status, 200);
    await submitForm('Add session');
    await page.locator('#session-assignment-error').waitFor();
    assert.equal(await col('studysessions').countDocuments({ notes: N('stale assignment') }), 0);
    await eventually(async () => !(await page.locator('#session-assignment option').allInnerTexts()).some((o) => o.includes('Vanishing')), 'the assignment list to refresh');
    assert.equal(await page.locator('#session-assignment').inputValue(), '', 'the vanished assignment is dropped');
    await submitForm('Add session'); // now saves with no assignment
    await text('Study session added.').waitFor();
    assert.equal((await col('studysessions').findOne({ notes: N('stale assignment') })).assignment, null);
  });

  // ---------- paging ----------
  await step('R13', 'Paging: 21 sessions make 2 pages; the totals still cover all of them', async () => {
    await clearSessions();
    for (let start = 0; start < 21; start += 7) {
      await Promise.all(Array.from({ length: 7 }, (_, i) => apiSession(maths, { date: ymd(-(start + i)), durationMinutes: 10 + start + i })));
    }
    await go(`${app}/study-sessions`);
    await eventually(async () => (await cardsShown()) === 20, '20 cards on page 1');
    await text('Showing 20 of 21 sessions').waitFor();
    await text('Page 1 of 2').waitFor();
    const all = await storedMinutes({});
    assert.equal((await total('view').innerText()).trim(), fmt(all.minutes), 'the total covers all 21, not just the 20 shown');
    assert.equal(await page.getByRole('button', { name: 'Previous', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await eventually(async () => (await cardsShown()) === 1, 'one card on page 2');
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await eventually(async () => (await cardsShown()) === 20, 'back on page 1');
  });

  // ---------- failures ----------
  await step('R14', 'List failing (HTTP 500) shows an error and "Try again" recovers; an unreachable server is explained', { provoked: true }, async () => {
    await clearSessions();
    await apiSession(maths, { durationMinutes: 33 });
    await page.route(LIST_URL, (route) => route.fulfill(json500));
    await page.goto(`${app}/study-sessions`);
    await page.getByRole('alert').filter({ hasText: 'Something went wrong on the server.' }).waitFor();
    await page.unroute(LIST_URL);
    await page.getByRole('button', { name: 'Try again' }).click();
    await item('Maths', '33 min').waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.route(LIST_URL, (route) => route.abort('connectionrefused'));
    await page.reload();
    await page.getByRole('alert').filter({ hasText: 'Cannot reach the StudyFlow server' }).waitFor();
    await page.unroute(LIST_URL);
  });

  await step('R15', 'A failed save keeps the form and its text; a failed delete shows an error and keeps the session', { provoked: true }, async () => {
    await go(`${app}/study-sessions`);
    await item('Maths', '33 min').waitFor();
    await page.route(LIST_URL, (route) => route.request().method() === 'POST' ? route.fulfill(json500) : route.continue());
    await openForm();
    await fillForm({ subject: maths.id, durationMinutes: 44, notes: N('will fail') });
    await submitForm('Add session');
    await page.getByRole('alert').filter({ hasText: 'Something went wrong' }).waitFor();
    assert.equal(await page.locator('#session-durationMinutes').inputValue(), '44');
    assert.equal(await page.locator('#session-notes').inputValue(), N('will fail'));
    assert.ok(await page.getByRole('button', { name: 'Add session', exact: true }).isEnabled());
    await page.unroute(LIST_URL);
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.route(ITEM_URL, (route) => route.request().method() === 'DELETE' ? route.abort('connectionrefused') : route.continue());
    await item('Maths', '33 min').getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Cannot reach the StudyFlow server' }).waitFor();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await item('Maths', '33 min').count(), 1);
    await page.unroute(ITEM_URL);
  });

  await step('R16', 'A session deleted elsewhere: editing it shows "not found" instead of failing silently', { provoked: true }, async () => {
    const victim = await apiSession(maths, { durationMinutes: 77 });
    await go(`${app}/study-sessions`);
    await item('Maths', '1 h 17 min').waitFor();
    await api('DELETE', `/study-sessions/${victim.id}`);
    await item('Maths', '1 h 17 min').getByRole('button', { name: /^Edit/ }).click();
    await fillForm({ durationMinutes: 78 });
    await submitForm('Save changes');
    await page.getByRole('alert').filter({ hasText: 'Study session not found.' }).waitFor();
    assert.equal(await col('studysessions').countDocuments({ durationMinutes: 78, notes: { $regex: `^${tag}_` } }), 0, 'nothing was resurrected');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  // ---------- dates and time zones ----------
  await step('R17', "\"Today\" and \"this week\" follow each time zone's own calendar (far east, far west, UTC offsets)", async () => {
    await clearSessions();
    const zoneSubject = await apiSubject('Zone subject');
    for (const timezoneId of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'Asia/Kolkata']) {
      const zonePage = await t.newPage({ timezoneId });
      try {
        await zonePage.goto(`${app}/study-sessions`);
        await zonePage.locator('#session-filter-q').waitFor();
        const days = await zonePage.evaluate(() => {
          const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const d = new Date();
          return { today: fmtDate(d), yesterday: fmtDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)) };
        });
        const todaySession = await apiSession(zoneSubject, { date: days.today, durationMinutes: 25 });
        const yesterdaySession = await apiSession(zoneSubject, { date: days.yesterday, durationMinutes: 100 });
        await zonePage.reload();
        await zonePage.locator('#session-filter-q').waitFor();
        await eventually(async () => (await zonePage.getByTestId('total-today').innerText()).trim() === '25 min', `${timezoneId}: today counts only the session dated today`);
        assert.equal((await zonePage.getByTestId('total-view').innerText()).trim(), fmt(125), `${timezoneId}: all-time counts both`);
        await api('DELETE', `/study-sessions/${todaySession.id}`);
        await api('DELETE', `/study-sessions/${yesterdaySession.id}`);
      } finally {
        await zonePage.context().close();
      }
    }
  });

  // ---------- layout, accessibility, safety ----------
  await step('R18', 'Layout at 1280, 768 and 375 px: summary cards, filters and cards adapt, long names wrap, nothing scrolls sideways, form stacks', async () => {
    await clearSessions();
    const longSubject = await apiSubject('', { name: N('').padEnd(100, 'W') });
    await apiSession(longSubject, { durationMinutes: 600, notes: N('x'.repeat(900)), type: 'Group study' });
    await apiSession(maths, { durationMinutes: 45 });
    for (const [width, height] of [[1280, 800], [768, 1024], [375, 812]]) {
      await page.setViewportSize({ width, height });
      await go(`${app}/study-sessions`);
      await page.locator('li.session-item').first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}px: no horizontal scroll`);
      const cards = page.locator('.summary-card');
      const first = await cards.nth(0).boundingBox();
      const second = await cards.nth(1).boundingBox();
      if (width === 375) assert.ok(second.y > first.y, '375px: summary cards stack');
      if (width === 1280) assert.ok(Math.abs(second.y - first.y) < 5 && second.x > first.x, '1280px: summary cards sit side by side');
      const items = page.locator('li.session-item');
      for (let i = 0; i < await items.count(); i += 1) {
        const box = await items.nth(i).boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${width}px: session ${i} fits the screen`);
        const title = await items.nth(i).locator('h2').boundingBox();
        assert.ok(title.x + title.width <= box.x + box.width + 1, `${width}px: name stays inside session ${i}`);
      }
      if (width === 375) {
        await openForm();
        const subject = await page.locator('#session-subject').boundingBox();
        const date = await page.locator('#session-date').boundingBox();
        assert.ok(date.y > subject.y, '375px: form fields stack in one column');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '375px: no horizontal scroll with the form open');
        await shot(page, 'sessions-07-mobile-form');
        await page.getByRole('button', { name: 'Cancel' }).click();
        await shot(page, 'sessions-08-mobile-list');
      }
      if (width === 1280) await shot(page, 'sessions-09-desktop');
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await step('R19', 'Accessibility basics: every control has a label, totals are in a named region, focus starts in the form, keyboard submits', async () => {
    await go(`${app}/study-sessions`);
    assert.equal(await page.getByRole('region', { name: 'Study time totals' }).count(), 1);
    for (const label of [/^Search notes/, /^Subject$/, /^Type$/, /^From$/, /^Until$/, /^Sort by$/, /^Order$/]) {
      assert.equal(await page.getByLabel(label).count(), 1, `filter label ${label}`);
    }
    await page.getByRole('button', { name: 'Add session', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Add a study session' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'session-subject');
    const form = page.locator('form.form');
    for (const label of [/^Subject/, /^Assignment \(optional\)/, /^Date/, /^Start time \(optional\)/, /^Duration in minutes/, /^Type \(optional\)/, /^Notes \(optional\)/]) {
      assert.equal(await form.getByLabel(label).count(), 1, `form label ${label}`);
    }
    await fillForm({ subject: maths.id, durationMinutes: 15, notes: N('keyboard') });
    await page.locator('#session-durationMinutes').focus();
    await page.keyboard.press('Enter');
    await text('Study session added.').waitFor();
    assert.equal((await col('studysessions').findOne({ notes: N('keyboard') })).durationMinutes, 15);
  });

  await step('R20', 'HTML in notes or a subject name is shown as text and never executed (XSS check)', async () => {
    await clearSessions();
    const evil = await apiSubject('', { name: N('<img src=x onerror=window.__xss=1>') });
    await apiSession(evil, { durationMinutes: 21, notes: N('<script>window.__xss=2</script>') });
    await go(`${app}/study-sessions`);
    await page.locator('li.session-item').first().waitFor();
    await page.locator('summary', { hasText: 'Show notes' }).click();
    assert.equal(await page.locator('li.session-item img, .subject-breakdown img').count(), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.match(await page.locator('li.session-item').first().innerText(), /<img src=x onerror=window\.__xss=1>/);
    assert.match(await page.locator('.assignment-details p').innerText(), /<script>/);
  });
}
