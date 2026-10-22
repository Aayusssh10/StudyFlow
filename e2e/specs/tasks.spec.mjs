import assert from 'node:assert/strict';
import { eventually, pad, sleep, ymd } from '../lib/helpers.mjs';

export const name = 'Daily tasks page';

export default async function run(t) {
  const { app, db, N, tag, step, shot, api } = t;
  const page = await t.newPage();
  const col = db.col;

  // ---------- helpers ----------
  const strip = (title) => title.replace(`${tag}_`, '');
  // Matches the WHOLE title (so 'Late' does not also match 'Late but done').
  // Matches the WHOLE title (so "Late" does not also match "Late but done").
  const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const item = (label) => page.locator('li.task-item', { has: page.locator('h2.task-title', { hasText: exactly(N(label)) }) });
  const shownLabels = async () => (await page.locator('li.task-item h2.task-title').allInnerTexts()).map(strip);

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

  const go = async (url) => { await page.goto(url); await page.locator('#task-filter-q').waitFor(); await page.waitForLoadState('networkidle'); };
  const reload = async () => { await page.reload(); await page.locator('#task-filter-q').waitFor(); await page.waitForLoadState('networkidle'); };
  const text = (value) => page.getByText(value, { exact: false });
  const tab = (label) => page.getByRole('group', { name: 'Which tasks to show' }).getByRole('button', { name: label, exact: true });
  const LIST_URL = /\/api\/tasks(\?.*)?$/;
  const ITEM_URL = /\/api\/tasks\/[0-9a-f]{24}(\/completed)?(\?.*)?$/;
  const json500 = { status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Something went wrong on the server.' } }) };

  const apiTask = async (label, fields = {}) => {
    const res = await api('POST', '/tasks', { title: N(label), date: ymd(0), ...fields });
    assert.equal(res.status, 201, `creating ${label}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const apiSubject = async (label) => {
    const res = await api('POST', '/subjects', { name: N(label) });
    assert.equal(res.status, 201);
    return res.body.data;
  };
  const apiAssignment = async (label, fields = {}) => {
    const res = await api('POST', '/assignments', { title: N(label), dueDate: ymd(10), ...fields });
    assert.equal(res.status, 201, `creating assignment ${label}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  async function clearTasks() {
    const { body } = await api('GET', '/tasks?limit=200');
    await Promise.all(body.data.map((task) => api('DELETE', `/tasks/${task.id}`)));
  }
  const stored = (label) => col('tasks').findOne({ title: N(label) });

  async function openForm() {
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.getByRole('heading', { name: 'Add a task' }).waitFor();
  }
  async function fillForm(f) {
    if (f.title !== undefined) await page.locator('#task-title').fill(f.title);
    if (f.date !== undefined) await page.locator('#task-date').fill(f.date);
    if (f.time !== undefined) await page.locator('#task-time').fill(f.time);
    if (f.priority !== undefined) await page.locator('#task-priority').selectOption(f.priority);
    if (f.description !== undefined) await page.locator('#task-description').fill(f.description);
    if (f.linkType !== undefined) await page.locator('#task-linkType').selectOption(f.linkType);
    if (f.subject !== undefined) await page.locator('#task-subject').selectOption(f.subject);
    if (f.assignment !== undefined) await page.locator('#task-assignment').selectOption(f.assignment);
  }
  const submitForm = (label) => page.getByRole('button', { name: label, exact: true }).click();

  // ---------- loading, empty state, today ----------
  await step('K1', 'Loading state, then the empty "Nothing planned" day for today with a working "Add a task" button', async () => {
    await page.route(LIST_URL, async (route) => {
      await sleep(1500);
      try { await route.continue(); } catch { /* page already moved on */ }
    });
    await page.goto(`${app}/tasks`);
    await text('Loading tasks...').waitFor({ timeout: 1200 });
    await text('Nothing planned for this day').waitFor();
    await page.unroute(LIST_URL);
    assert.match(await page.locator('.day-nav h2').innerText(), /\(today\)/, 'the planner opens on today');
    assert.equal(await tab('Day planner').getAttribute('aria-pressed'), 'true');
    await shot(page, 'tasks-01-empty');
    await page.getByRole('button', { name: 'Add a task' }).click();
    await page.getByRole('heading', { name: 'Add a task' }).waitFor();
    assert.equal(await page.locator('#task-date').inputValue(), ymd(0), 'a new task defaults to the day being viewed');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('K2', 'Required fields and the "Link to" choice are validated; nothing is sent when invalid', async () => {
    let posts = 0;
    const count = (request) => { if (request.method() === 'POST') posts += 1; };
    page.on('request', count);
    await openForm();
    await page.locator('#task-date').fill('');
    await submitForm('Add task');
    await page.locator('#task-title-error').waitFor();
    assert.equal(await page.locator('#task-title-error').innerText(), 'Title is required.');
    assert.equal(await page.locator('#task-date-error').innerText(), 'Date is required.');
    assert.equal(await page.locator('#task-title').getAttribute('aria-invalid'), 'true');

    await fillForm({ title: '   ', date: ymd(0) });
    await submitForm('Add task');
    assert.equal(await page.locator('#task-title-error').innerText(), 'Title is required.', 'spaces only is still blank');

    await fillForm({ title: N('x'), linkType: 'subject' });
    await submitForm('Add task');
    await page.locator('#task-subject-error').waitFor();
    assert.match(await page.locator('#task-subject-error').innerText(), /Choose a subject/);
    await fillForm({ linkType: 'assignment' });
    assert.equal(await page.locator('#task-subject').count(), 0, 'only one link kind is offered at a time');
    await submitForm('Add task');
    await page.locator('#task-assignment-error').waitFor();
    assert.match(await page.locator('#task-assignment-error').innerText(), /Choose an assignment/);
    page.off('request', count);
    assert.equal(posts, 0, 'no POST was sent for invalid input');
    assert.equal(await col('tasks').countDocuments({}), 0);
    await shot(page, 'tasks-02-validation');
  });

  await step('K3', 'With no subjects or assignments yet, the link choices explain where to add them', async () => {
    await fillForm({ linkType: 'subject' });
    const subjectLink = page.getByRole('link', { name: 'Add one on the Subjects page' });
    await subjectLink.waitFor();
    assert.match(await subjectLink.getAttribute('href'), /\/subjects$/);
    await fillForm({ linkType: 'assignment' });
    const assignmentLink = page.getByRole('link', { name: 'Add one on the Assignments page' });
    await assignmentLink.waitFor();
    assert.match(await assignmentLink.getAttribute('href'), /\/assignments$/);
    await fillForm({ linkType: '' });
    assert.equal(await page.locator('#task-subject, #task-assignment').count(), 0);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  // ---------- creating ----------
  let maths;
  let essay;
  await step('K4', 'Tasks can be created in the UI: plain, linked to a subject, and linked to an assignment (subject derived)', async () => {
    maths = await apiSubject('Maths');
    essay = await apiAssignment('Essay', { subject: maths.id });
    await go(`${app}/tasks`);

    await openForm();
    // Late in the day, so the task is still "today" (not overdue) whenever the test runs.
    await fillForm({ title: N('Plain'), time: '23:59', priority: 'High', description: 'Read chapter 4' });
    await submitForm('Add task');
    await text('Task added.').waitFor();
    const plain = item('Plain');
    await plain.waitFor();
    const plainText = await plain.innerText();
    assert.match(plainText, /11:59\s?PM/);
    assert.match(plainText, /High priority/);
    assert.equal(await plain.getAttribute('data-timing'), 'today');
    await plain.locator('summary', { hasText: 'Show description' }).click();
    await text('Read chapter 4').waitFor();
    const plainRow = await stored('Plain');
    assert.equal(plainRow.date, ymd(0), 'date saved exactly as shown (no time zone shift)');
    assert.equal(plainRow.time, '23:59');
    assert.equal(plainRow.priority, 'High');
    assert.equal(plainRow.completed, false);

    await openForm();
    await fillForm({ title: N('With subject'), linkType: 'subject', subject: maths.id });
    await submitForm('Add task');
    const withSubject = item('With subject');
    await withSubject.waitFor();
    assert.match(await withSubject.innerText(), new RegExp(N('Maths')));
    const subjectRow = await stored('With subject');
    assert.equal(subjectRow.subject.toString(), maths.id);
    assert.equal(subjectRow.assignment, null);

    await openForm();
    await fillForm({ title: N('With assignment'), linkType: 'assignment', assignment: essay.id });
    await submitForm('Add task');
    const withAssignment = item('With assignment');
    await withAssignment.waitFor();
    const linkedText = await withAssignment.innerText();
    assert.match(linkedText, new RegExp(`Assignment: ${N('Essay')}`));
    assert.match(linkedText, new RegExp(N('Maths')), "the assignment's subject is shown too");
    const assignmentRow = await stored('With assignment');
    assert.equal(assignmentRow.assignment.toString(), essay.id);
    assert.equal(assignmentRow.subject, null, 'the subject is NOT copied into the task');
    await shot(page, 'tasks-03-created');
  });

  await step('K5', 'The link drop-downs list real subjects and assignments, alphabetically / in due order, one kind at a time', async () => {
    await openForm();
    await fillForm({ linkType: 'subject' });
    assert.deepEqual(await page.locator('#task-subject option').allInnerTexts(), ['Choose a subject...', N('Maths')]);
    await fillForm({ linkType: 'assignment' });
    assert.deepEqual(await page.locator('#task-assignment option').allInnerTexts(), ['Choose an assignment...', `${N('Essay')} (${N('Maths')})`]);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('K6', 'A server-side validation error is shown and the form keeps its text', { provoked: true }, async () => {
    const POST_ONLY = /\/api\/tasks(\?.*)?$/;
    await page.route(POST_ONLY, (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Validation failed.', details: [{ field: 'time', message: 'Time from server.' }, { field: 'title', message: 'Title from server.' }] } }) })
      : route.continue());
    await openForm();
    await fillForm({ title: N('Mocked'), date: ymd(0) });
    await submitForm('Add task');
    await page.getByRole('alert').filter({ hasText: 'Validation failed.' }).waitFor();
    assert.equal(await page.locator('#task-time-error').innerText(), 'Time from server.');
    assert.equal(await page.locator('#task-title-error').innerText(), 'Title from server.');
    assert.equal(await page.locator('#task-title').inputValue(), N('Mocked'));
    await page.unroute(POST_ONLY);
    assert.equal(await col('tasks').countDocuments({ title: N('Mocked') }), 0);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  // ---------- completing ----------
  await step('K7', 'Ticking a task off shows progress, a "Done" badge and persists; unticking brings it back', async () => {
    await clearTasks();
    await apiTask('One', { time: '08:00' });
    await apiTask('Two', { time: '12:00' });
    await apiTask('Three');
    await reload();
    await expectShown(['One', 'Two', 'Three'], { ordered: true }); // timed first, untimed last
    await text('0 of 3 done').waitFor();

    const checkbox = item('Two').getByRole('checkbox', { name: `Mark "${N('Two')}" as done` });
    await checkbox.click(); // the box flips once the server has confirmed, so wait for the message instead of the state
    await text(`Marked "${N('Two')}" as done.`).waitFor();
    await text('1 of 3 done').waitFor();
    await eventually(async () => (await item('Two').getAttribute('data-timing')) === 'completed', 'task to become done');
    assert.ok((await item('Two').locator('.badge').allInnerTexts()).includes('Done'));
    assert.equal((await stored('Two')).completed, true);
    await shot(page, 'tasks-04-progress');

    await item('Two').getByRole('checkbox', { name: `Mark "${N('Two')}" as not done` }).click();
    await text(`Reopened "${N('Two')}".`).waitFor();
    await text('0 of 3 done').waitFor();
    assert.equal((await stored('Two')).completed, false);
  });

  // ---------- navigating days ----------
  await step('K8', 'Day navigation: next / previous day, jump to a date, back to today', async () => {
    await clearTasks();
    await apiTask('Today task', { date: ymd(0) });
    await apiTask('Tomorrow task', { date: ymd(1) });
    await apiTask('Yesterday task', { date: ymd(-1) });
    await reload();
    await expectShown(['Today task']);

    await page.getByRole('button', { name: 'Next day' }).click();
    await expectShown(['Tomorrow task']);
    assert.doesNotMatch(await page.locator('.day-nav h2').innerText(), /\(today\)/);
    assert.equal(await page.getByRole('button', { name: 'Today', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: 'Next day' }).click();
    await text('Nothing planned for this day').waitFor();

    await page.getByRole('button', { name: 'Previous day' }).click();
    await page.getByRole('button', { name: 'Previous day' }).click();
    await page.getByRole('button', { name: 'Previous day' }).click();
    await expectShown(['Yesterday task']);

    await page.locator('#day-picker').fill(ymd(1));
    await expectShown(['Tomorrow task']);
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expectShown(['Today task']);
    assert.equal(await page.getByRole('button', { name: 'Today', exact: true }).isDisabled(), true, 'Today is disabled when already on today');
    assert.match(await page.locator('.day-nav h2').innerText(), /\(today\)/);
  });

  await step('K9', 'Overdue, Upcoming and All views; a done task is never overdue', async () => {
    await clearTasks();
    await apiTask('Late', { date: ymd(-2) });
    await apiTask('Late but done', { date: ymd(-5), completed: true });
    await apiTask('Soon', { date: ymd(3) });
    await apiTask('Now', { date: ymd(0) });
    await reload();

    await tab('Overdue').click();
    await expectShown(['Late']);
    assert.equal(await item('Late').getAttribute('data-timing'), 'overdue');
    assert.ok((await item('Late').locator('.badge').allInnerTexts()).includes('Overdue'));
    assert.ok((await item('Late').innerText()).includes(ymd(-2).slice(0, 4)), 'the date (with its year) is shown outside the day planner');
    await shot(page, 'tasks-05-overdue');

    await tab('Upcoming').click();
    await expectShown(['Soon']);
    await tab('All tasks').click();
    await expectShown(['Late but done', 'Late', 'Now', 'Soon'], { ordered: true });
    assert.equal(await item('Late but done').getAttribute('data-timing'), 'completed');
    const edgeColors = new Set();
    for (const label of ['Late', 'Now', 'Soon', 'Late but done']) edgeColors.add(await item(label).evaluate((el) => getComputedStyle(el).borderLeftColor));
    assert.equal(edgeColors.size, 4, 'overdue, today, upcoming and done tasks have four different edge colours');
    await tab('Day planner').click();
    await expectShown(['Now']);
  });

  await step('K10', 'Filters: show to-do/done, priority, search; combined; "no matches" state; Clear filters', async () => {
    await clearTasks();
    await apiTask('F-alpha', { priority: 'High' });
    await apiTask('F-bravo', { priority: 'Low', completed: true });
    await apiTask('F-charlie', { priority: 'Medium' });
    await reload();
    await expectShown(['F-alpha', 'F-bravo', 'F-charlie']);

    await page.locator('#task-filter-completed').selectOption('false');
    await expectShown(['F-alpha', 'F-charlie']);
    await page.locator('#task-filter-completed').selectOption('true');
    await expectShown(['F-bravo']);
    await page.locator('#task-filter-completed').selectOption('');
    await page.locator('#task-filter-priority').selectOption('High');
    await expectShown(['F-alpha']);
    await page.locator('#task-filter-priority').selectOption('');
    await page.locator('#task-filter-q').fill('CHARLIE');
    await expectShown(['F-charlie']);
    await page.locator('#task-filter-q').fill('');
    await expectShown(['F-alpha', 'F-bravo', 'F-charlie']);

    await page.locator('#task-filter-completed').selectOption('true');
    await page.locator('#task-filter-priority').selectOption('High');
    await text('No tasks match your filters').waitFor();
    await shot(page, 'tasks-06-no-matches');
    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expectShown(['F-alpha', 'F-bravo', 'F-charlie']);
    assert.equal(await page.locator('#task-filter-completed').inputValue(), '');
    assert.equal(await page.getByRole('button', { name: 'Clear filters' }).count(), 0);
  });

  // ---------- editing ----------
  await step('K11', 'Editing: pre-filled form, switch the link from a subject to an assignment, change fields; persists after reload', async () => {
    await clearTasks();
    await apiTask('Edit me', { subject: maths.id, time: '10:00', priority: 'Low', description: 'before' });
    await reload();
    await item('Edit me').getByRole('button', { name: /^Edit/ }).click();
    await page.getByRole('heading', { name: 'Edit task' }).waitFor();
    assert.equal(await page.locator('#task-title').inputValue(), N('Edit me'));
    assert.equal(await page.locator('#task-time').inputValue(), '10:00');
    assert.equal(await page.locator('#task-priority').inputValue(), 'Low');
    assert.equal(await page.locator('#task-linkType').inputValue(), 'subject', 'the current link kind is selected');
    assert.equal(await page.locator('#task-subject').inputValue(), maths.id);

    await fillForm({ title: N('Edited'), time: '15:45', priority: 'High', linkType: 'assignment', assignment: essay.id });
    await submitForm('Save changes');
    await text('Task updated.').waitFor();
    await item('Edited').waitFor();
    await reload();
    const c = item('Edited');
    await c.waitFor();
    assert.match(await c.innerText(), /3:45\s?PM/);
    assert.match(await c.innerText(), new RegExp(`Assignment: ${N('Essay')}`));
    const row = await stored('Edited');
    assert.equal(row.subject, null, 'the old subject link is gone');
    assert.equal(row.assignment.toString(), essay.id);
    assert.equal(row.priority, 'High');
    assert.equal(row.description, 'before', 'fields that were not touched keep their values');
  });

  await step('K12', 'Delete asks for confirmation; Cancel and Escape keep the task; Confirm deletes it', async () => {
    await clearTasks();
    await apiTask('D-keep');
    await apiTask('D-remove');
    await reload();
    const target = item('D-remove');
    const dialog = page.getByRole('dialog');

    await target.getByRole('button', { name: /^Delete/ }).click();
    await dialog.waitFor();
    assert.match(await dialog.innerText(), new RegExp(`Delete "${N('D-remove')}"\\?`));
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await target.count(), 1);

    await target.getByRole('button', { name: /^Delete/ }).click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await col('tasks').countDocuments({ title: N('D-remove') }), 1);

    await target.getByRole('button', { name: /^Delete/ }).click();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await text(`Deleted "${N('D-remove')}".`).waitFor();
    await target.waitFor({ state: 'detached' });
    assert.equal(await col('tasks').countDocuments({ title: N('D-remove') }), 0);
    assert.equal(await col('tasks').countDocuments({ title: N('D-keep') }), 1, 'the other task is untouched');
  });

  // ---------- integration ----------
  await step('K13', 'A subject that a task uses cannot be deleted on the Subjects page; once the task is gone it can', { provoked: true }, async () => {
    await clearTasks();
    const subject = await apiSubject('Task subject');
    const linked = await apiTask('S-linked', { subject: subject.id });

    await page.goto(`${app}/subjects`);
    const subjectCard = page.locator('li.subject-card', { hasText: N('Task subject') });
    await subjectCard.waitFor();
    await subjectCard.getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Cannot delete' });
    await alert.waitFor();
    assert.match(await alert.innerText(), /still used by 1 task/);
    assert.equal(await subjectCard.count(), 1);

    await api('DELETE', `/tasks/${linked.id}`);
    await page.reload();
    await subjectCard.waitFor();
    await subjectCard.getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await text(`Deleted "${N('Task subject')}".`).waitFor();
  });

  await step('K14', 'Deleting an assignment on the Assignments page keeps its tasks and clears their link', async () => {
    await clearTasks();
    const assignment = await apiAssignment('Doomed essay');
    const task = await apiTask('A-linked', { assignment: assignment.id });

    await page.goto(`${app}/assignments`);
    await page.locator('#filter-q').waitFor();
    const assignmentCard = page.locator('li.assignment-card', { has: page.locator('h2.assignment-title', { hasText: N('Doomed essay') }) });
    await assignmentCard.waitFor();
    await assignmentCard.getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await text(`Deleted "${N('Doomed essay')}".`).waitFor();

    await go(`${app}/tasks`);
    const c = item('A-linked');
    await c.waitFor();
    assert.doesNotMatch(await c.innerText(), /Assignment:/, 'the link is gone');
    const row = await stored('A-linked');
    assert.equal(row.assignment, null);
    assert.equal(row._id.toString(), task.id, 'it is the same task');
    assert.equal(await col('assignments').countDocuments({ title: N('Doomed essay') }), 0);
    await shot(page, 'tasks-07-unlinked');
  });

  await step('K15', 'A subject or assignment deleted elsewhere while the form is open: saving is refused, the list refreshes, nothing dangles', { provoked: true }, async () => {
    await clearTasks();
    const [gone, goneAssignment] = [await apiSubject('Vanishing'), await apiAssignment('Vanishing essay')];
    await go(`${app}/tasks`);

    await openForm();
    await fillForm({ title: N('Stale subject'), linkType: 'subject', subject: gone.id });
    assert.equal((await api('DELETE', `/subjects/${gone.id}`)).status, 200);
    await submitForm('Add task');
    await page.locator('#task-subject-error').waitFor();
    await page.getByRole('alert').filter({ hasText: 'does not exist' }).waitFor();
    assert.equal(await col('tasks').countDocuments({ title: N('Stale subject') }), 0, 'nothing was saved');
    await eventually(async () => !(await page.locator('#task-subject option').allInnerTexts()).includes(N('Vanishing')), 'the subject list to refresh');
    assert.equal(await page.locator('#task-subject').inputValue(), '', 'the vanished choice is dropped');

    // Saving again WITHOUT choosing something new must be refused by the form itself (the stale id must not be re-sent).
    let posts = 0;
    const count = (request) => { if (request.method() === 'POST') posts += 1; };
    page.on('request', count);
    await submitForm('Add task');
    await eventually(async () => (await page.locator('#task-subject-error').innerText()) === 'Choose a subject, or change "Link to" to Nothing.', 'the form to ask for a new choice');
    await sleep(300);
    page.off('request', count);
    assert.equal(posts, 0, 'the vanished subject id was not sent to the server again');

    await fillForm({ linkType: '' });
    await submitForm('Add task');
    await item('Stale subject').waitFor();
    assert.equal((await stored('Stale subject')).subject, null);

    await openForm();
    await fillForm({ title: N('Stale assignment'), linkType: 'assignment', assignment: goneAssignment.id });
    assert.equal((await api('DELETE', `/assignments/${goneAssignment.id}`)).status, 200);
    await submitForm('Add task');
    await page.locator('#task-assignment-error').waitFor();
    assert.equal(await col('tasks').countDocuments({ title: N('Stale assignment') }), 0);
    await eventually(async () => !(await page.locator('#task-assignment option').allInnerTexts()).some((o) => o.includes('Vanishing')), 'the assignment list to refresh');
    assert.equal(await page.locator('#task-assignment').inputValue(), '', 'the vanished choice is dropped');
    let assignmentPosts = 0;
    const countAssignment = (request) => { if (request.method() === 'POST') assignmentPosts += 1; };
    page.on('request', countAssignment);
    await submitForm('Add task');
    await eventually(async () => (await page.locator('#task-assignment-error').innerText()) === 'Choose an assignment, or change "Link to" to Nothing.', 'the form to ask for a new choice');
    await sleep(300);
    page.off('request', countAssignment);
    assert.equal(assignmentPosts, 0, 'the vanished assignment id was not sent to the server again');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  // ---------- paging ----------
  await step('K16', 'Paging: 51 tasks make 2 pages in "All tasks"; Next and Previous work', async () => {
    await clearTasks();
    for (let start = 0; start < 51; start += 10) {
      await Promise.all(Array.from({ length: Math.min(10, 51 - start) }, (_, i) => apiTask(`P-${pad(start + i)}`, { date: ymd(start + i + 1) })));
    }
    await go(`${app}/tasks`);
    await tab('All tasks').click();
    await eventually(async () => (await shownLabels()).length === 50, '50 items on page 1');
    await text('Showing 50 of 51 tasks').waitFor();
    await text('Page 1 of 2').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Previous', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expectShown(['P-50']);
    await text('Page 2 of 2').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await eventually(async () => (await shownLabels()).length === 50, 'back on page 1');
    await shot(page, 'tasks-08-paging');
  });

  // ---------- failures ----------
  await step('K17', 'List failing (HTTP 500) shows an error; "Try again" recovers; an unreachable server is explained', { provoked: true }, async () => {
    await clearTasks();
    await apiTask('E-one');
    await page.route(LIST_URL, (route) => route.fulfill(json500));
    await page.goto(`${app}/tasks`);
    await page.getByRole('alert').filter({ hasText: 'Something went wrong on the server.' }).waitFor();
    await page.unroute(LIST_URL);
    await page.getByRole('button', { name: 'Try again' }).click();
    await item('E-one').waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);

    await page.route(LIST_URL, (route) => route.abort('connectionrefused'));
    await page.reload();
    await page.getByRole('alert').filter({ hasText: 'Cannot reach the StudyFlow server' }).waitFor();
    await page.unroute(LIST_URL);
  });

  await step('K18', 'A failed save keeps the form and text; a failed tick-off and a failed delete show errors and change nothing', { provoked: true }, async () => {
    await go(`${app}/tasks`);
    await item('E-one').waitFor();

    await page.route(LIST_URL, (route) => route.request().method() === 'POST' ? route.fulfill(json500) : route.continue());
    await openForm();
    await fillForm({ title: N('Will fail'), date: ymd(0) });
    await submitForm('Add task');
    await page.getByRole('alert').filter({ hasText: 'Something went wrong' }).waitFor();
    assert.equal(await page.locator('#task-title').inputValue(), N('Will fail'));
    assert.ok(await page.getByRole('button', { name: 'Add task', exact: true }).isEnabled());
    await page.unroute(LIST_URL);
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.route(ITEM_URL, (route) => ['PATCH', 'DELETE'].includes(route.request().method()) ? route.abort('connectionrefused') : route.continue());
    await item('E-one').getByRole('checkbox').click();
    await page.getByRole('alert').filter({ hasText: 'Cannot reach the StudyFlow server' }).waitFor();
    assert.equal((await stored('E-one')).completed, false, 'nothing changed');
    assert.equal(await item('E-one').getByRole('checkbox').isChecked(), false, 'the checkbox is back to unticked');

    await item('E-one').getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Cannot reach the StudyFlow server' }).waitFor();
    await page.getByRole('dialog').waitFor({ state: 'hidden' }); // it closes a moment after the message appears
    assert.equal(await item('E-one').count(), 1);
    await page.unroute(ITEM_URL);
  });

  await step('K19', 'A task deleted elsewhere: editing it shows "not found" instead of failing silently', { provoked: true }, async () => {
    const victim = await apiTask('Ghost');
    await go(`${app}/tasks`);
    await item('Ghost').waitFor();
    await api('DELETE', `/tasks/${victim.id}`);
    await item('Ghost').getByRole('button', { name: /^Edit/ }).click();
    await fillForm({ title: N('Ghost renamed') });
    await submitForm('Save changes');
    await page.getByRole('alert').filter({ hasText: 'Task not found.' }).waitFor();
    assert.equal(await col('tasks').countDocuments({ title: N('Ghost renamed') }), 0);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  // ---------- dates and time zones ----------
  await step('K20', 'The day planner, overdue and today follow each time zone (far east, far west, UTC offsets)', async () => {
    await clearTasks();
    for (const timezoneId of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'Asia/Kolkata']) {
      const zonePage = await t.newPage({ timezoneId });
      try {
        await zonePage.goto(`${app}/tasks`);
        await zonePage.locator('#task-filter-q').waitFor();
        const days = await zonePage.evaluate(() => {
          const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const d = new Date();
          return { today: fmt(d), yesterday: fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)) };
        });
        await apiTask(`Z-today-${timezoneId}`, { date: days.today });
        await apiTask(`Z-yesterday-${timezoneId}`, { date: days.yesterday });
        await zoneReload(zonePage);
        const zoneItem = (label) => zonePage.locator('li.task-item', { has: zonePage.locator('h2.task-title', { hasText: N(label) }) });
        await zoneItem(`Z-today-${timezoneId}`).waitFor();
        assert.equal(await zoneItem(`Z-today-${timezoneId}`).getAttribute('data-timing'), 'today', `${timezoneId}: planned for its local today is not overdue`);
        assert.equal(await zoneItem(`Z-yesterday-${timezoneId}`).count(), 0, `${timezoneId}: yesterday's task is not in today's planner`);
        await zonePage.getByRole('group', { name: 'Which tasks to show' }).getByRole('button', { name: 'Overdue', exact: true }).click();
        await zoneItem(`Z-yesterday-${timezoneId}`).waitFor();
        assert.equal(await zoneItem(`Z-yesterday-${timezoneId}`).getAttribute('data-timing'), 'overdue', `${timezoneId}: yesterday's task is overdue`);
      } finally {
        await zonePage.context().close();
      }
    }
    await clearTasks();
  });

  // ---------- layout, accessibility, safety ----------
  await step('K21', 'Layout at 1280, 768 and 375 px: day navigation and filters adapt, long text wraps, nothing scrolls sideways, form stacks', async () => {
    await clearTasks();
    const longTitle = N('').padEnd(100, 'W');
    await api('POST', '/tasks', { title: longTitle, date: ymd(0), time: '08:00', description: 'x'.repeat(900), priority: 'High', subject: maths.id }).then((r) => assert.equal(r.status, 201));
    await apiTask('Layout-normal');
    for (const [width, height] of [[1280, 800], [768, 1024], [375, 812]]) {
      await page.setViewportSize({ width, height });
      await go(`${app}/tasks`);
      await page.locator('li.task-item').first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}px: no horizontal scroll`);
      const items = page.locator('li.task-item');
      if (width === 1280) {
        const q = await page.locator('#task-filter-q').boundingBox();
        const show = await page.locator('#task-filter-completed').boundingBox();
        const priority = await page.locator('#task-filter-priority').boundingBox();
        assert.ok(Math.abs(q.y - show.y) < 5 && Math.abs(show.y - priority.y) < 5, 'search, show and priority sit on one row on desktop');
      }
      for (let i = 0; i < await items.count(); i += 1) {
        const box = await items.nth(i).boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${width}px: task ${i} fits the screen`);
        const title = await items.nth(i).locator('h2').boundingBox();
        assert.ok(title.x + title.width <= box.x + box.width + 1, `${width}px: title stays inside task ${i}`);
      }
      if (width === 375) {
        const prev = await page.getByRole('button', { name: 'Previous day' }).boundingBox();
        const next = await page.getByRole('button', { name: 'Next day' }).boundingBox();
        assert.ok(next.y > prev.y, '375px: day navigation stacks');
        await openForm();
        const title = await page.locator('#task-title').boundingBox();
        const date = await page.locator('#task-date').boundingBox();
        const time = await page.locator('#task-time').boundingBox();
        assert.ok(date.y > title.y && time.y > date.y, '375px: form fields stack in one column');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '375px: no horizontal scroll with the form open');
        await shot(page, 'tasks-09-mobile-form');
        await page.getByRole('button', { name: 'Cancel' }).click();
        await shot(page, 'tasks-10-mobile-list');
      }
      if (width === 1280) await shot(page, 'tasks-11-desktop');
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await step('K22', 'Accessibility basics: labels on every control, named checkboxes and tab group, focus in the title, keyboard submit', async () => {
    await go(`${app}/tasks`);
    for (const label of [/^Search by title/, /^Show$/, /^Priority$/, /^Go to date$/]) {
      assert.equal(await page.getByLabel(label).count(), 1, `label ${label}`);
    }
    assert.equal(await page.getByRole('group', { name: 'Which tasks to show' }).count(), 1);
    assert.equal(await page.getByRole('checkbox', { name: /^Mark ".*" as done$/ }).count() >= 1, true, 'checkboxes have meaningful names');

    await page.getByRole('button', { name: 'Add task', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Add a task' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'task-title');
    const form = page.locator('form.form');
    for (const label of [/^Title/, /^Date/, /^Time \(optional\)/, /^Priority$/, /^Link to$/, /^Description \(optional\)/]) {
      assert.equal(await form.getByLabel(label).count(), 1, `form label ${label}`);
    }
    await page.keyboard.type(N('Keyboard'));
    await page.locator('#task-title').focus();
    await page.keyboard.press('Enter');
    await item('Keyboard').waitFor();
    assert.equal((await stored('Keyboard')).date, ymd(0));
    assert.equal(await page.getByRole('list', { name: 'Your tasks' }).count(), 1);
  });

  await step('K23', 'HTML in a title, description or linked names is shown as text and never executed (XSS check)', async () => {
    await clearTasks();
    await apiTask('', { title: N('<img src=x onerror=window.__xss=1>'), description: '<script>window.__xss=2</script>' });
    await go(`${app}/tasks`);
    await page.locator('li.task-item').first().waitFor();
    await page.locator('summary', { hasText: 'Show description' }).click();
    assert.equal(await page.locator('li.task-item img').count(), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.match(await page.locator('li.task-item').first().innerText(), /<img src=x onerror=window\.__xss=1>/);
    assert.match(await page.locator('.assignment-details p').innerText(), /<script>/);
  });

}

async function zoneReload(zonePage) {
  await zonePage.reload();
  await zonePage.locator('#task-filter-q').waitFor();
  await zonePage.waitForLoadState('networkidle');
}
