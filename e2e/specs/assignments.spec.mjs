import assert from 'node:assert/strict';
import { pad, sleep, ymd } from '../lib/helpers.mjs';

export const name = 'Assignments page';

export default async function run(t) {
  const { app, db, N, tag, step, shot, api } = t;
  const page = await t.newPage();
  const col = db.col;

  // ---------- helpers ----------
  const strip = (title) => title.replace(`${tag}_`, '');
  const card = (label) => page.locator('li.assignment-card', { has: page.locator('h2.assignment-title', { hasText: N(label) }) });
  const shownLabels = async () => (await page.locator('li.assignment-card h2.assignment-title').allInnerTexts()).map(strip);

  async function eventually(check, message, timeout = 7000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { if (await check()) return; } catch (error) { last = error; }
      await sleep(100);
    }
    throw new Error(`Timed out waiting for: ${message}${last ? ` (${last.message})` : ''}`);
  }
  // Waits until the list shows exactly these assignments (in this order if `ordered`).
  async function expectShown(expected, { ordered = false } = {}) {
    let actual = [];
    await eventually(async () => {
      actual = await shownLabels();
      const a = ordered ? actual : [...actual].sort();
      const e = ordered ? expected : [...expected].sort();
      return JSON.stringify(a) === JSON.stringify(e);
    }, `list to show ${JSON.stringify(expected)}`).catch((error) => {
      throw new Error(`${error.message}; last seen: ${JSON.stringify(actual)}`);
    });
  }

  const go = async (url) => { await page.goto(url); await page.locator('#filter-q').waitFor(); await page.waitForLoadState('networkidle'); };
  const reload = async () => { await page.reload(); await page.locator('#filter-q').waitFor(); await page.waitForLoadState('networkidle'); };
  const text = (value) => page.getByText(value, { exact: false });
  const LIST_URL = /\/api\/assignments(\?.*)?$/;
  const ITEM_URL = /\/api\/assignments\/[0-9a-f]{24}(\/status)?(\?.*)?$/;
  const json500 = { status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Something went wrong on the server.' } }) };

  const apiCreate = async (label, fields = {}) => {
    const res = await api('POST', '/assignments', { title: N(label), dueDate: ymd(7), ...fields });
    assert.equal(res.status, 201, `creating ${label}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const apiSubject = async (label) => {
    const res = await api('POST', '/subjects', { name: N(label) });
    assert.equal(res.status, 201);
    return res.body.data;
  };
  // Empties the (test) assignments collection through the API, so a step starts from a known state.
  async function clearAssignments() {
    const { body } = await api('GET', '/assignments?limit=200');
    for (const a of body.data) assert.equal((await api('DELETE', `/assignments/${a.id}`)).status, 200);
  }
  const stored = (label) => col('assignments').findOne({ title: N(label) });

  async function openForm() {
    await page.getByRole('button', { name: 'Add assignment', exact: true }).click();
    await page.getByRole('heading', { name: 'Add an assignment' }).waitFor();
  }
  async function fillForm(f) {
    if (f.title !== undefined) await page.locator('#assignment-title').fill(f.title);
    if (f.subject !== undefined) await page.locator('#assignment-subject').selectOption(f.subject);
    if (f.type !== undefined) await page.locator('#assignment-type').selectOption(f.type);
    if (f.dueDate !== undefined) await page.locator('#assignment-dueDate').fill(f.dueDate);
    if (f.dueTime !== undefined) await page.locator('#assignment-dueTime').fill(f.dueTime);
    if (f.priority !== undefined) await page.locator('#assignment-priority').selectOption(f.priority);
    if (f.status !== undefined) await page.locator('#assignment-status').selectOption(f.status);
    if (f.estimatedMinutes !== undefined) await page.locator('#assignment-estimatedMinutes').fill(String(f.estimatedMinutes));
    if (f.description !== undefined) await page.locator('#assignment-description').fill(f.description);
  }
  const submitForm = (label) => page.getByRole('button', { name: label, exact: true }).click();

  // ---------- empty and loading states ----------
  await step('A1', 'Loading state, then the empty state with a working "Add your first assignment" button', async () => {
    await page.route(LIST_URL, async (route) => {
      await sleep(1500);
      try { await route.continue(); } catch { /* page already moved on */ }
    });
    await page.goto(`${app}/assignments`);
    await text('Loading assignments...').waitFor({ timeout: 1200 });
    await text('No assignments yet').waitFor();
    await page.unroute(LIST_URL);
    await shot(page, 'assignments-01-empty');
    await page.getByRole('button', { name: 'Add your first assignment' }).click();
    await page.getByRole('heading', { name: 'Add an assignment' }).waitFor();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('heading', { name: 'Add an assignment' }).waitFor({ state: 'detached' });
  });

  await step('A2', 'Required fields (title, due date) show messages and send no request', async () => {
    let posts = 0;
    const count = (request) => { if (request.method() === 'POST') posts += 1; };
    page.on('request', count);
    await openForm();
    await submitForm('Add assignment');
    await page.locator('#assignment-title-error').waitFor();
    await page.locator('#assignment-dueDate-error').waitFor();
    assert.equal(await page.locator('#assignment-title-error').innerText(), 'Title is required.');
    assert.equal(await page.locator('#assignment-dueDate-error').innerText(), 'Due date is required.');
    assert.equal(await page.locator('#assignment-title').getAttribute('aria-invalid'), 'true');
    await fillForm({ title: '   ' });
    await submitForm('Add assignment');
    assert.equal(await page.locator('#assignment-title-error').innerText(), 'Title is required.', 'spaces only is still blank');
    await fillForm({ title: N('Only title') });
    await submitForm('Add assignment');
    await page.locator('#assignment-title-error').waitFor({ state: 'detached' });
    await page.locator('#assignment-dueDate-error').waitFor();
    page.off('request', count);
    assert.equal(posts, 0, 'no POST was sent for invalid input');
    assert.equal(await col('assignments').countDocuments({}), 0);
    await shot(page, 'assignments-02-validation');
  });

  await step('A3', 'With no subjects yet, the subject drop-down offers "No subject" and links to the Subjects page', async () => {
    assert.deepEqual(await page.locator('#assignment-subject option').allInnerTexts(), ['No subject']);
    const link = page.getByRole('link', { name: 'Add one on the Subjects page' });
    await link.waitFor();
    assert.match(await link.getAttribute('href'), /\/subjects$/);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  // ---------- creating with subjects ----------
  let chem, maths, physics;
  await step('A4', 'The subject drop-down lists the real subjects alphabetically (and a filter offers the same)', async () => {
    [chem, maths, physics] = [await apiSubject('Chem'), await apiSubject('Maths'), await apiSubject('Physics')];
    await go(`${app}/assignments`);
    await openForm();
    assert.deepEqual(await page.locator('#assignment-subject option').allInnerTexts(), ['No subject', N('Chem'), N('Maths'), N('Physics')]);
    assert.deepEqual(await page.locator('#filter-subject option').allInnerTexts(), ['All subjects', 'No subject', N('Chem'), N('Maths'), N('Physics')]);
    assert.equal(await page.getByRole('link', { name: 'Add one on the Subjects page' }).count(), 0, 'hint is gone once subjects exist');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('A5', 'A full assignment can be created in the UI; the card and the database both show the right values', async () => {
    const due = ymd(5);
    await openForm();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'assignment-title', 'title is focused when the form opens');
    await fillForm({
      title: N('Lab report'), subject: maths.id, type: 'Project', dueDate: due, dueTime: '14:30',
      priority: 'High', status: 'In Progress', estimatedMinutes: 90, description: 'Write up the pendulum experiment',
    });
    await submitForm('Add assignment');
    await text('Assignment added.').waitFor();
    const c = card('Lab report');
    await c.waitFor();
    const cardText = await c.innerText();
    assert.match(cardText, new RegExp(N('Maths')));
    assert.match(cardText, /2:30\s?PM/);
    assert.match(cardText, /High priority/);
    assert.match(cardText, /In Progress/);
    assert.match(cardText, /Project/);
    assert.match(cardText, /1 h 30 min/);
    assert.equal(await c.getAttribute('data-timing'), 'upcoming', 'five days ahead is "upcoming", not "due soon"');
    await c.locator('summary', { hasText: 'Show description' }).click();
    await text('Write up the pendulum experiment').waitFor();

    const row = await stored('Lab report');
    assert.equal(row.subject.toString(), maths.id, 'saved with the chosen subject');
    assert.equal(row.dueDate, due, 'due date saved exactly as chosen (no time zone shift)');
    assert.equal(row.dueTime, '14:30');
    assert.equal(row.priority, 'High');
    assert.equal(row.status, 'In Progress');
    assert.equal(row.estimatedMinutes, 90);
    assert.equal(row.type, 'Project');
    await shot(page, 'assignments-03-created');
  });

  await step('A6', 'A minimal assignment (title + due date) gets sensible defaults', async () => {
    await openForm();
    await fillForm({ title: N('Quick'), dueDate: ymd(40) });
    await submitForm('Add assignment');
    const c = card('Quick');
    await c.waitFor();
    const cardText = await c.innerText();
    assert.match(cardText, /No subject/);
    assert.match(cardText, /Medium priority/);
    assert.match(cardText, /Upcoming/);
    const row = await stored('Quick');
    assert.equal(row.subject, null);
    assert.equal(row.status, 'Not Started');
    assert.equal(row.estimatedMinutes, null);
  });

  await step('A7', 'A server-side validation error (estimated minutes 0) is shown next to its field and the form stays open', { provoked: true }, async () => {
    await openForm();
    await fillForm({ title: N('Bad estimate'), dueDate: ymd(3), estimatedMinutes: 0 });
    await submitForm('Add assignment');
    await page.locator('#assignment-estimatedMinutes-error').waitFor();
    assert.match(await page.locator('#assignment-estimatedMinutes-error').innerText(), /whole number from 1 to 10080/);
    await page.getByRole('alert').filter({ hasText: 'Validation failed.' }).waitFor();
    assert.equal(await page.locator('#assignment-title').inputValue(), N('Bad estimate'), 'typed data is kept');
    assert.ok(await page.getByRole('button', { name: 'Add assignment', exact: true }).isEnabled());
    assert.equal(await col('assignments').countDocuments({ title: N('Bad estimate') }), 0, 'nothing was saved');
    await shot(page, 'assignments-04-server-validation');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('A8', 'A subject deleted elsewhere while the form is open: saving is refused, the drop-down refreshes, nothing dangles', { provoked: true }, async () => {
    await openForm();
    await fillForm({ title: N('Stale subject'), dueDate: ymd(9), subject: chem.id });
    assert.equal((await api('DELETE', `/subjects/${chem.id}`)).status, 200, 'someone deletes the (unused) subject meanwhile');
    await submitForm('Add assignment');
    await page.locator('#assignment-subject-error').waitFor();
    await page.getByRole('alert').filter({ hasText: 'does not exist' }).waitFor();
    assert.equal(await col('assignments').countDocuments({ title: N('Stale subject') }), 0, 'nothing was saved');
    await eventually(async () => !(await page.locator('#assignment-subject option').allInnerTexts()).includes(N('Chem')), 'drop-down to refresh');
    assert.equal(await page.locator('#assignment-subject').inputValue(), '', 'selection falls back to "No subject"');
    assert.equal(await page.locator('#assignment-title').inputValue(), N('Stale subject'), 'typed data is kept');
    await submitForm('Add assignment'); // resubmitting without the vanished subject works
    await card('Stale subject').waitFor();
    assert.equal((await stored('Stale subject')).subject, null);
    assert.equal(await page.getByRole('alert').count(), 0);
  });

  // ---------- editing and completing ----------
  await step('A9', 'An assignment can be edited (title, subject, priority, date); the change shows and persists after reload', async () => {
    await card('Lab report').getByRole('button', { name: /^Edit/ }).click();
    await page.getByRole('heading', { name: 'Edit assignment' }).waitFor();
    assert.equal(await page.locator('#assignment-title').inputValue(), N('Lab report'), 'form is pre-filled');
    assert.equal(await page.locator('#assignment-subject').inputValue(), maths.id);
    assert.equal(await page.locator('#assignment-dueTime').inputValue(), '14:30');
    assert.equal(await page.locator('#assignment-estimatedMinutes').inputValue(), '90');
    await fillForm({ title: N('Lab report v2'), subject: physics.id, priority: 'Low', dueDate: ymd(6) });
    await submitForm('Save changes');
    await text('Assignment updated.').waitFor();
    await card('Lab report v2').waitFor();
    assert.ok(!(await shownLabels()).includes('Lab report'), 'the old title is gone');
    await reload();
    const c = card('Lab report v2');
    await c.waitFor();
    assert.match(await c.innerText(), new RegExp(N('Physics')));
    assert.match(await c.innerText(), /Low priority/);
    const row = await stored('Lab report v2');
    assert.equal(row.subject.toString(), physics.id);
    assert.equal(row.dueDate, ymd(6));
    assert.equal(row.estimatedMinutes, 90, 'fields that were not touched are kept');
  });

  await step('A10', '"Mark complete" completes an assignment and "Reopen" brings it back', async () => {
    const c = card('Quick');
    await c.getByRole('button', { name: /^Mark complete/ }).click();
    await text(`Marked "${N('Quick')}" as complete.`).waitFor();
    await eventually(async () => (await c.getAttribute('data-timing')) === 'completed', 'card to become completed');
    assert.match(await c.innerText(), /Completed/);
    assert.equal((await stored('Quick')).status, 'Completed');
    await c.getByRole('button', { name: /^Reopen/ }).click();
    await text(`Reopened "${N('Quick')}".`).waitFor();
    await eventually(async () => (await c.getAttribute('data-timing')) === 'upcoming', 'card to be pending again');
    assert.equal((await stored('Quick')).status, 'Not Started');
  });

  // ---------- timing display ----------
  await step('A11', 'Overdue, due soon, upcoming and completed assignments look different, and completed is never overdue', async () => {
    await clearAssignments();
    await apiCreate('T-overdue', { dueDate: ymd(-2) });
    await apiCreate('T-soon', { dueDate: ymd(1) });
    await apiCreate('T-upcoming', { dueDate: ymd(20) });
    await apiCreate('T-done-old', { dueDate: ymd(-30), status: 'Completed' });
    await apiCreate('T-done-future', { dueDate: ymd(10), status: 'Completed' });
    await reload();
    const expected = { 'T-overdue': ['overdue', 'Overdue'], 'T-soon': ['dueSoon', 'Due soon'], 'T-upcoming': ['upcoming', 'Upcoming'], 'T-done-old': ['completed', 'Completed'], 'T-done-future': ['completed', 'Completed'] };
    for (const [label, [timing, badge]] of Object.entries(expected)) {
      const c = card(label);
      await c.waitFor();
      assert.equal(await c.getAttribute('data-timing'), timing, label);
      assert.ok((await c.locator('.badge').allInnerTexts()).includes(badge), `${label} shows the text "${badge}"`);
    }
    const borderColors = new Set();
    for (const label of Object.keys(expected)) borderColors.add(await card(label).evaluate((el) => getComputedStyle(el).borderLeftColor));
    assert.equal(borderColors.size, 4, 'four different edge colours');
    assert.ok(!(await card('T-done-old').locator('.badge').allInnerTexts()).includes('Overdue'), 'an old completed assignment is not overdue');
    await shot(page, 'assignments-05-timing');
  });

  // ---------- filters, search, sorting ----------
  await step('A12', 'Filters, search and sorting work, alone and combined, with a clear "no matches" state', async () => {
    await clearAssignments();
    const [m2, p2] = [maths, physics];
    await apiCreate('F-alpha', { subject: m2.id, priority: 'High', status: 'Not Started', dueDate: ymd(2), type: 'Homework' });
    await apiCreate('F-bravo', { subject: p2.id, priority: 'Low', status: 'In Progress', dueDate: ymd(-3) });
    await apiCreate('F-charlie', { priority: 'Medium', status: 'Completed', dueDate: ymd(-10) });
    await apiCreate('F-delta', { subject: m2.id, priority: 'Medium', status: 'Not Started', dueDate: ymd(15) });
    await reload();
    const all = ['F-charlie', 'F-bravo', 'F-alpha', 'F-delta'];
    await expectShown(all, { ordered: true }); // default sort: due date, soonest first
    await text('Showing 4 of 4 assignments').waitFor();

    const pick = (id, value) => page.locator(id).selectOption(value);
    await pick('#filter-subject', m2.id); await expectShown(['F-alpha', 'F-delta'], { ordered: true });
    await pick('#filter-subject', 'none'); await expectShown(['F-charlie']);
    await pick('#filter-subject', p2.id); await expectShown(['F-bravo']);
    await pick('#filter-subject', '');
    await pick('#filter-status', 'In Progress'); await expectShown(['F-bravo']);
    await pick('#filter-status', 'Completed'); await expectShown(['F-charlie']);
    await pick('#filter-status', '');
    await pick('#filter-priority', 'High'); await expectShown(['F-alpha']);
    await pick('#filter-priority', '');
    await pick('#filter-timing', 'overdue'); await expectShown(['F-bravo']);
    await pick('#filter-timing', 'dueSoon'); await expectShown(['F-alpha']);
    await pick('#filter-timing', 'upcoming'); await expectShown(['F-delta']);
    await pick('#filter-timing', 'completed'); await expectShown(['F-charlie']);
    await pick('#filter-timing', '');

    await page.locator('#filter-dueFrom').fill(ymd(-5));
    await page.locator('#filter-dueTo').fill(ymd(5));
    await expectShown(['F-bravo', 'F-alpha'], { ordered: true });
    await page.locator('#filter-dueFrom').fill(ymd(2));
    await expectShown(['F-alpha']);
    await page.locator('#filter-dueFrom').fill('');
    await page.locator('#filter-dueTo').fill('');
    await expectShown(all, { ordered: true });

    await page.locator('#filter-q').fill('CHARLIE'); // case-insensitive, after a short typing pause
    await expectShown(['F-charlie']);
    await page.locator('#filter-q').fill('');
    await expectShown(all, { ordered: true });

    await pick('#filter-subject', m2.id);
    await pick('#filter-status', 'Not Started'); await expectShown(['F-alpha', 'F-delta']);
    await pick('#filter-priority', 'High'); await expectShown(['F-alpha']);
    await pick('#filter-priority', 'Low'); // Maths + Not Started + Low: nothing
    await text('No assignments match your filters').waitFor();
    assert.equal(await page.getByText('No assignments yet').count(), 0, 'a different message than the "empty" state');
    await shot(page, 'assignments-06-no-matches');
    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expectShown(all, { ordered: true });
    assert.equal(await page.locator('#filter-subject').inputValue(), '');
    assert.equal(await page.locator('#filter-status').inputValue(), '');
    assert.equal(await page.locator('#filter-priority').inputValue(), '');
    assert.equal(await page.getByRole('button', { name: 'Clear filters' }).count(), 0, '"Clear filters" disappears when nothing is filtered');

    // sorting (A=alpha High +2, B=bravo Low -3, C=charlie Medium -10, D=delta Medium +15; added in order A,B,C,D)
    await pick('#filter-sort', 'priority'); await expectShown(['F-alpha', 'F-charlie', 'F-delta', 'F-bravo'], { ordered: true });
    await pick('#filter-order', 'asc'); await expectShown(['F-bravo', 'F-charlie', 'F-delta', 'F-alpha'], { ordered: true });
    await pick('#filter-sort', 'createdAt'); // choosing a new sort resets the order to its default (newest first)
    await expectShown(['F-delta', 'F-charlie', 'F-bravo', 'F-alpha'], { ordered: true });
    await pick('#filter-order', 'asc'); await expectShown(['F-alpha', 'F-bravo', 'F-charlie', 'F-delta'], { ordered: true });
    await pick('#filter-sort', 'dueDate'); await pick('#filter-order', 'desc');
    await expectShown(['F-delta', 'F-alpha', 'F-bravo', 'F-charlie'], { ordered: true });
  });

  // ---------- deleting ----------
  await step('A13', 'Delete asks for confirmation; Cancel and Escape keep the assignment; Confirm deletes it', async () => {
    await clearAssignments();
    await apiCreate('D-keep');
    await apiCreate('D-remove');
    await reload();
    const target = card('D-remove');
    const dialog = page.getByRole('dialog');

    await target.getByRole('button', { name: /^Delete/ }).click();
    await dialog.waitFor();
    assert.match(await dialog.innerText(), new RegExp(`Delete "${N('D-remove')}"\\?`));
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'focus starts on the safe button');
    await shot(page, 'assignments-07-delete-dialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await target.count(), 1);

    await target.getByRole('button', { name: /^Delete/ }).click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await col('assignments').countDocuments({ title: N('D-remove') }), 1);

    await target.getByRole('button', { name: /^Delete/ }).click();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await text(`Deleted "${N('D-remove')}".`).waitFor();
    await target.waitFor({ state: 'detached' });
    assert.equal(await col('assignments').countDocuments({ title: N('D-remove') }), 0, 'removed from the database');
    assert.equal(await col('assignments').countDocuments({ title: N('D-keep') }), 1, 'the other assignment is untouched');
  });

  // ---------- integration with subjects ----------
  await step('A14', 'A subject with assignments cannot be deleted on the Subjects page; once they are gone it can', { provoked: true }, async () => {
    await clearAssignments();
    const subject = await apiSubject('Linked');
    const a1 = await apiCreate('L-one', { subject: subject.id });
    const a2 = await apiCreate('L-two', { subject: subject.id });

    await page.goto(`${app}/subjects`);
    const subjectCard = page.locator('li.subject-card', { hasText: N('Linked') });
    await subjectCard.waitFor();
    await subjectCard.getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Cannot delete' });
    await alert.waitFor();
    assert.match(await alert.innerText(), /still used by 2 assignments/);
    assert.equal(await subjectCard.count(), 1);

    await api('DELETE', `/assignments/${a1.id}`);
    await api('DELETE', `/assignments/${a2.id}`);
    await page.reload();
    await subjectCard.waitFor();
    await subjectCard.getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await text(`Deleted "${N('Linked')}".`).waitFor();
    assert.equal(await col('subjects').countDocuments({ name: N('Linked') }), 0);
  });

  await step('A15', 'Renaming a subject shows the new name on its assignments', async () => {
    const subject = await apiSubject('Old name');
    await apiCreate('R-one', { subject: subject.id });
    assert.equal((await api('PUT', `/subjects/${subject.id}`, { name: N('New name'), color: '#ff0000' })).status, 200);
    await go(`${app}/assignments`);
    const chip = card('R-one').locator('.subject-chip');
    await chip.waitFor();
    assert.equal((await chip.innerText()).trim(), N('New name'));
    assert.equal(await chip.evaluate((el) => getComputedStyle(el).getPropertyValue('--subject-color').trim()), '#ff0000');
  });

  // ---------- paging ----------
  await step('A16', 'Paging: 21 assignments make 2 pages; deleting the only item on page 2 steps back to page 1', async () => {
    await clearAssignments();
    await Promise.all(Array.from({ length: 21 }, (_, i) => apiCreate(`P-${pad(i)}`, { dueDate: ymd(i + 1) })));
    await go(`${app}/assignments`);
    await eventually(async () => (await shownLabels()).length === 20, '20 items on page 1');
    await text('Showing 20 of 21 assignments').waitFor();
    await text('Page 1 of 2').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Previous' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Next' }).click();
    await expectShown(['P-20']);
    await text('Page 2 of 2').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Next' }).isDisabled(), true);
    await card('P-20').getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await eventually(async () => (await shownLabels()).length === 20, 'back on page 1 with 20 items');
    assert.equal(await page.getByRole('navigation', { name: 'Assignment pages' }).count(), 0, 'no pager for a single page');
    await shot(page, 'assignments-08-paging');
  });

  // ---------- failures ----------
  await step('A17', 'List request failing (HTTP 500) shows an error; "Try again" recovers; an unreachable server is explained', { provoked: true }, async () => {
    await clearAssignments();
    await apiCreate('E-one');
    await page.route(LIST_URL, (route) => route.fulfill(json500));
    await page.goto(`${app}/assignments`);
    await page.getByRole('alert').filter({ hasText: 'Something went wrong on the server.' }).waitFor();
    await shot(page, 'assignments-09-list-error');
    await page.unroute(LIST_URL);
    await page.getByRole('button', { name: 'Try again' }).click();
    await card('E-one').waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);

    await page.route(LIST_URL, (route) => route.abort('connectionrefused'));
    await page.reload();
    await page.getByRole('alert').filter({ hasText: 'Cannot reach the StudyFlow server' }).waitFor();
    await page.unroute(LIST_URL);
  });

  await step('A18', 'A failed save (HTTP 500) keeps the form and its text; a failed "Mark complete" and a failed delete show errors and change nothing', { provoked: true }, async () => {
    await go(`${app}/assignments`);
    await card('E-one').waitFor();

    await page.route(LIST_URL, (route) => route.request().method() === 'POST' ? route.fulfill(json500) : route.continue());
    await openForm();
    await fillForm({ title: N('Will fail'), dueDate: ymd(4) });
    await submitForm('Add assignment');
    await page.getByRole('alert').filter({ hasText: 'Something went wrong' }).waitFor();
    assert.equal(await page.locator('#assignment-title').inputValue(), N('Will fail'));
    assert.ok(await page.getByRole('button', { name: 'Add assignment', exact: true }).isEnabled());
    await page.unroute(LIST_URL);
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.route(ITEM_URL, (route) => ['PATCH', 'DELETE'].includes(route.request().method()) ? route.abort('connectionrefused') : route.continue());
    await card('E-one').getByRole('button', { name: /^Mark complete/ }).click();
    await page.getByRole('alert').filter({ hasText: 'Cannot reach the StudyFlow server' }).waitFor();
    assert.equal((await stored('E-one')).status, 'Not Started');
    assert.equal(await card('E-one').getAttribute('data-timing'), 'upcoming', 'the card did not change to completed');

    await card('E-one').getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Cannot reach the StudyFlow server' }).waitFor();
    await page.getByRole('dialog').waitFor({ state: 'hidden' }); // it closes a moment after the message appears
    assert.equal(await card('E-one').count(), 1, 'still listed');
    await page.unroute(ITEM_URL);
  });

  await step('A19', 'An assignment deleted elsewhere: editing it shows "not found" instead of failing silently', { provoked: true }, async () => {
    const victim = await apiCreate('Ghost');
    await go(`${app}/assignments`);
    await card('Ghost').waitFor();
    await api('DELETE', `/assignments/${victim.id}`);
    await card('Ghost').getByRole('button', { name: /^Edit/ }).click();
    await fillForm({ title: N('Ghost renamed') });
    await submitForm('Save changes');
    await page.getByRole('alert').filter({ hasText: 'Assignment not found.' }).waitFor();
    assert.equal(await col('assignments').countDocuments({ title: N('Ghost renamed') }), 0, 'nothing was resurrected');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  // ---------- dates and time zones ----------
  await step('A20', 'Due dates and overdue/due-soon are correct in time zones far east and far west of UTC', async () => {
    await clearAssignments();
    await apiCreate('Z-fixed', { dueDate: '2031-03-09' }); // a US daylight-saving change day
    for (const timezoneId of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'Asia/Kolkata']) {
      const zonePage = await t.newPage({ timezoneId });
      try {
        await zonePage.goto(`${app}/assignments`);
        await zonePage.locator('#filter-q').waitFor();
        // "today" and "yesterday" as that time zone sees them
        const days = await zonePage.evaluate(() => {
          const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const d = new Date();
          const y = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
          return { today: fmt(d), yesterday: fmt(y), expected: new Date(2031, 2, 9).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) };
        });
        await apiCreate(`Z-today-${timezoneId}`, { dueDate: days.today });
        await apiCreate(`Z-yesterday-${timezoneId}`, { dueDate: days.yesterday });
        await zonePage.reload();
        const zoneCard = (label) => zonePage.locator('li.assignment-card', { has: zonePage.locator('h2.assignment-title', { hasText: N(label) }) });
        await zoneCard('Z-fixed').waitFor();
        assert.match(await zoneCard('Z-fixed').innerText(), new RegExp(days.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${timezoneId}: fixed date is shown as 9 March 2031`);
        assert.equal(await zoneCard(`Z-today-${timezoneId}`).getAttribute('data-timing'), 'dueSoon', `${timezoneId}: due today is not overdue`);
        assert.equal(await zoneCard(`Z-yesterday-${timezoneId}`).getAttribute('data-timing'), 'overdue', `${timezoneId}: due yesterday is overdue`);
      } finally {
        await zonePage.context().close();
      }
    }
    assert.equal((await stored('Z-fixed')).dueDate, '2031-03-09', 'stored date is plain text, unchanged');
  });

  // ---------- layout, accessibility, safety ----------
  await step('A21', 'Desktop layout (1280px): filter bar is a grid, cards fit, nothing scrolls sideways', async () => {
    await clearAssignments();
    const longTitle = N('').padEnd(100, 'W');
    const subject = await apiSubject('Layout');
    await apiCreate('', { title: longTitle, subject: subject.id, description: 'x'.repeat(1900), dueTime: '08:00', estimatedMinutes: 600, type: 'Exam', priority: 'High' });
    await apiCreate('Layout-normal', { subject: subject.id });
    await page.setViewportSize({ width: 1280, height: 800 });
    await go(`${app}/assignments`);
    await page.locator('li.assignment-card').first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll');
    const q = await page.locator('#filter-q').boundingBox();
    const subjectBox = await page.locator('#filter-subject').boundingBox();
    const status = await page.locator('#filter-status').boundingBox();
    assert.ok(Math.abs(q.y - subjectBox.y) < 5 && Math.abs(subjectBox.y - status.y) < 5, 'search, subject and status sit on the same row');
    assert.ok(q.x < subjectBox.x && subjectBox.x < status.x, 'laid out left to right');
    await shot(page, 'assignments-10-desktop');
  });

  await step('A22', 'Tablet (768px) and mobile (375px): filters stack, cards and forms fit, long text wraps, nothing scrolls sideways', async () => {
    for (const [width, height] of [[768, 1024], [375, 812]]) {
      await page.setViewportSize({ width, height });
      await go(`${app}/assignments`);
      await page.locator('li.assignment-card').first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}px: no horizontal scroll`);
      const cards = page.locator('li.assignment-card');
      for (let i = 0; i < await cards.count(); i += 1) {
        const box = await cards.nth(i).boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${width}px: card ${i} fits the screen`);
        const title = await cards.nth(i).locator('h2').boundingBox();
        assert.ok(title.x + title.width <= box.x + box.width + 1, `${width}px: title stays inside card ${i}`);
      }
      await openForm();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}px: no horizontal scroll with the form open`);
      if (width === 375) {
        const title = await page.locator('#assignment-title').boundingBox();
        const date = await page.locator('#assignment-dueDate').boundingBox();
        const time = await page.locator('#assignment-dueTime').boundingBox();
        assert.ok(date.y > title.y && time.y > date.y, '375px: form fields stack in one column');
        const search = await page.locator('#filter-q').boundingBox();
        const subject = await page.locator('#filter-subject').boundingBox();
        assert.ok(subject.y > search.y, '375px: filters stack in one column');
        await shot(page, 'assignments-11-mobile-form');
      }
      await page.getByRole('button', { name: 'Cancel' }).click();
      if (width === 375) await shot(page, 'assignments-12-mobile-list');
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await step('A23', 'Accessibility basics: every form and filter control has a label; focus starts in the title; keyboard can submit', async () => {
    await go(`${app}/assignments`);
    for (const label of [/^Search by title/, /^Subject$/, /^Status$/, /^Priority$/, /^Deadline$/, /^Due from$/, /^Due until$/, /^Sort by$/, /^Order$/]) {
      assert.equal(await page.getByLabel(label).count(), 1, `filter label ${label}`);
    }
    await page.getByRole('button', { name: 'Add assignment', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Add an assignment' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'assignment-title');
    const form = page.locator('form.form'); // scoped: the filter bar has "Status" and "Priority" labels too
    for (const label of [/^Title/, /^Subject \(optional\)/, /^Type \(optional\)/, /^Due date/, /^Due time \(optional\)/, /^Priority$/, /^Status$/, /^Estimated minutes \(optional\)/, /^Description \(optional\)/]) {
      assert.equal(await form.getByLabel(label).count(), 1, `form label ${label}`);
    }
    await page.keyboard.type(N('Keyboard')); // typed with the keyboard into the focused title field
    await page.locator('#assignment-dueDate').fill(ymd(12));
    await page.locator('#assignment-title').focus();
    await page.keyboard.press('Enter'); // Enter submits the form
    await card('Keyboard').waitFor();
    assert.equal((await stored('Keyboard')).dueDate, ymd(12));
    assert.equal(await page.getByRole('list', { name: 'Your assignments' }).count(), 1);
  });

  await step('A24', 'HTML in a title or description is shown as text and never executed (XSS check)', async () => {
    await clearAssignments();
    await apiCreate('', { title: N('<img src=x onerror=window.__xss=1>'), description: '<script>window.__xss=2</script>' });
    await go(`${app}/assignments`);
    await page.locator('li.assignment-card').first().waitFor();
    await page.locator('summary', { hasText: 'Show description' }).click();
    assert.equal(await page.locator('li.assignment-card img').count(), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.match(await page.locator('li.assignment-card').first().innerText(), /<img src=x onerror=window\.__xss=1>/);
    assert.match(await page.locator('.assignment-details p').innerText(), /<script>/);
  });
}
