import assert from 'node:assert/strict';
import fs from 'node:fs';
import { eventually, parseCsv, ymd } from '../lib/helpers.mjs';

export const name = 'Main workflow, as a student would use it (UI only)';

// One continuous journey. Everything is created, changed and deleted through the screens; the database is only used to confirm.
export default async function run(t) {
  const { app, db, N, tag, step, shot } = t;
  const page = await t.newPage({ acceptDownloads: true });
  const col = db.col;
  const today = ymd(0);
  const subjectName = N('Biology');
  const assignmentTitle = N('Lab report');
  const taskTitle = N('Write intro');
  const notes = N('chapter 1');

  // ---------- helpers ----------
  const go = async (path) => { await page.goto(`${app}${path}`); await page.getByRole('heading', { level: 1 }).first().waitFor(); await page.waitForLoadState('networkidle'); };
  const stat = (label) => page.getByTestId(`stat-${label}`);
  const expectStat = (label, value) => eventually(async () => (await stat(label).innerText()).trim() === value, `${label} = ${value}`);
  const confirmDelete = async () => { await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' }); };
  const stored = (collection, field, value) => col(collection).countDocuments({ [field]: { $regex: `^${value}`, $options: 'i' } });

  await step('W1', 'First visit: the empty dashboard welcomes a new student and points to the first step', async () => {
    await go('/');
    await page.getByRole('heading', { name: 'Welcome to StudyFlow' }).waitFor();
    await page.getByRole('link', { name: 'Add your first subject' }).click();
    await page.getByRole('heading', { name: 'Subjects', level: 1 }).waitFor();
  });

  await step('W2', 'Add a subject', async () => {
    await page.getByRole('button', { name: 'Add your first subject' }).click();
    await page.getByLabel('Name').fill(subjectName);
    await page.getByLabel('Code (optional)').fill('BIO101');
    await page.getByRole('button', { name: 'Add subject', exact: true }).click();
    await page.getByText(`Subject added`, { exact: false }).first().waitFor();
    await page.locator('li.subject-card', { hasText: subjectName }).waitFor();
    assert.equal(await stored('subjects', 'name', subjectName), 1);
  });

  await step('W3', 'Add an assignment for that subject, due today: it shows as "Due soon"', async () => {
    await go('/assignments');
    await page.getByRole('button', { name: 'Add your first assignment' }).click();
    await page.locator('#assignment-title').fill(assignmentTitle);
    await page.locator('#assignment-subject').selectOption({ label: subjectName });
    await page.locator('#assignment-dueDate').fill(today);
    await page.locator('#assignment-priority').selectOption('High');
    await page.getByRole('button', { name: 'Add assignment', exact: true }).click();
    const card = page.locator('li.assignment-card', { hasText: assignmentTitle });
    await card.waitFor();
    assert.equal(await card.getAttribute('data-timing'), 'dueSoon');
    await card.getByText('Due soon').waitFor();
    await card.getByText('High priority').waitFor();
    await shot(page, 'workflow-01-assignment');
  });

  await step('W4', 'Plan a task for today, linked to the assignment', async () => {
    await go('/tasks');
    await page.getByRole('button', { name: 'Add task', exact: true }).first().click();
    await page.locator('#task-title').fill(taskTitle);
    await page.locator('#task-linkType').selectOption({ label: 'An assignment' });
    await page.locator('#task-assignment').selectOption({ label: `${assignmentTitle} (${subjectName})` });
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    const item = page.locator('li.task-item', { hasText: taskTitle });
    await item.waitFor();
    await item.getByText(`Assignment: ${assignmentTitle}`).waitFor();
    await item.getByText(subjectName).waitFor();
  });

  await step('W5', 'Record 45 minutes of study', async () => {
    await go('/study-sessions');
    await page.getByRole('button', { name: 'Add your first session' }).click();
    await page.locator('#session-subject').selectOption({ label: subjectName });
    await page.locator('#session-durationMinutes').fill('45');
    await page.locator('#session-type').selectOption('Revision');
    await page.locator('#session-notes').fill(notes);
    await page.getByRole('button', { name: 'Add session', exact: true }).click();
    await page.locator('li.session-item', { hasText: notes }).waitFor();
    await eventually(async () => (await page.getByTestId('total-today').innerText()).trim() === '45 min', 'today total 45 min');
  });

  await step('W6', 'The dashboard now shows all of it, calculated from the saved records', async () => {
    await go('/');
    await page.getByRole('region', { name: 'Summary' }).waitFor();
    await expectStat('subjects', '1');
    await expectStat('pending-assignments', '1');
    await expectStat('due-soon', '1');
    await expectStat('overdue-assignments', '0');
    await expectStat('tasks-today', '0 / 1');
    await expectStat('study-today', '45 min');
    assert.equal(await page.getByRole('heading', { name: 'Welcome to StudyFlow' }).count(), 0);
    await page.getByRole('list', { name: 'Upcoming deadlines' }).getByText(assignmentTitle).waitFor();
    await page.getByRole('list', { name: "Today's tasks" }).getByText(taskTitle).waitFor();
    await shot(page, 'workflow-02-dashboard');
  });

  await step('W7', 'Tick the task off: the task page, the dashboard and the calendar agree', async () => {
    await go('/tasks');
    const item = page.locator('li.task-item', { hasText: taskTitle });
    await item.getByRole('checkbox', { name: `Mark "${taskTitle}" as done` }).click();
    await page.getByText(`Marked "${taskTitle}" as done.`).waitFor();
    assert.equal(await item.getAttribute('data-timing'), 'completed');
    await go('/');
    await expectStat('tasks-today', '1 / 1');

    await go('/calendar');
    const agenda = page.getByRole('list', { name: 'Events on the selected day' });
    await agenda.getByRole('button', { name: `Due: ${assignmentTitle}` }).waitFor();
    await agenda.getByRole('button', { name: `Task: ${taskTitle} (done)` }).waitFor();
    await agenda.getByRole('button', { name: `Studied: ${subjectName} (45 min)` }).waitFor();
    await agenda.getByRole('button', { name: `Task: ${taskTitle} (done)` }).click();
    await page.getByRole('link', { name: 'Open in Tasks' }).click();
    await page.getByRole('heading', { name: 'Edit task' }).waitFor();
    assert.equal(await page.locator('#task-title').inputValue(), taskTitle);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('W8', 'Complete the assignment: reports move from 0% to 100%, and the CSV export has the row', async () => {
    await go('/reports');
    await page.locator('#report-period').selectOption({ label: 'All time' });
    await eventually(async () => /Assignment completion 0% 0 of 1 completed/.test((await page.getByTestId('figure-assignment-completion').innerText()).replace(/\s+/g, ' ')), 'report shows 0%');
    await eventually(async () => /^Study time 45 min/.test((await page.getByTestId('figure-study-time').innerText()).replace(/\s+/g, ' ')), 'report shows 45 min');

    await go('/assignments');
    await page.locator('li.assignment-card', { hasText: assignmentTitle }).getByRole('button', { name: /^Mark complete/ }).click();
    await page.getByText(`Marked "${assignmentTitle}" as complete.`).waitFor();

    await go('/reports');
    await page.locator('#report-period').selectOption({ label: 'All time' });
    await eventually(async () => /Assignment completion 100% 1 of 1 completed/.test((await page.getByTestId('figure-assignment-completion').innerText()).replace(/\s+/g, ' ')), 'report shows 100%');
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export assignments', exact: true }).click()]);
    const rows = parseCsv(new TextDecoder('utf-8', { ignoreBOM: true }).decode(fs.readFileSync(await file.path())).slice(1));
    assert.equal(rows.length, 2);
    assert.equal(rows[1][0], assignmentTitle);
    assert.equal(rows[1][1], subjectName);
    assert.equal(rows[1][4], 'Completed');
    assert.equal(rows[1][8], 'completed');
    await shot(page, 'workflow-03-report');
  });

  await step('W9', 'A subject that is still in use cannot be deleted, and the message says why', { provoked: true }, async () => {
    await go('/subjects');
    await page.locator('li.subject-card', { hasText: subjectName }).getByRole('button', { name: /^Delete/ }).click();
    await confirmDelete();
    await page.getByRole('alert').getByText(`Cannot delete "${subjectName}" because it is still used by`, { exact: false }).waitFor();
    await page.locator('li.subject-card', { hasText: subjectName }).waitFor();
    assert.equal(await stored('subjects', 'name', subjectName), 1, 'the subject is still in the database');
  });

  await step('W10', 'A changed setting applies across the app (year-first dates)', async () => {
    await go('/settings');
    await page.locator('#setting-dateFormat').selectOption('iso');
    await go('/assignments');
    await page.locator('li.assignment-card', { hasText: assignmentTitle }).getByText(today).waitFor();
    await go('/settings');
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
  });

  await step('W11', 'Delete everything in the right order: the subject can go once nothing uses it, and the dashboard is empty again', async () => {
    await go('/study-sessions');
    await page.locator('li.session-item', { hasText: notes }).getByRole('button', { name: /^Delete/ }).click();
    await confirmDelete();
    await page.getByText('Study session deleted.').waitFor();

    await go('/tasks');
    await page.locator('li.task-item', { hasText: taskTitle }).getByRole('button', { name: /^Delete/ }).click();
    await confirmDelete();
    await page.getByText(`Deleted "${taskTitle}".`).waitFor();

    await go('/assignments');
    await page.locator('li.assignment-card', { hasText: assignmentTitle }).getByRole('button', { name: /^Delete/ }).click();
    await confirmDelete();
    await page.getByText(`Deleted "${assignmentTitle}".`).waitFor();

    await go('/subjects');
    await page.locator('li.subject-card', { hasText: subjectName }).getByRole('button', { name: /^Delete/ }).click();
    await confirmDelete();
    await page.getByText('No subjects yet').waitFor();

    await go('/');
    await page.getByRole('heading', { name: 'Welcome to StudyFlow' }).waitFor();
    await expectStat('subjects', '0');
    assert.deepEqual(
      [await stored('subjects', 'name', tag), await stored('assignments', 'title', tag), await stored('tasks', 'title', tag), await stored('studysessions', 'notes', tag)],
      [0, 0, 0, 0],
      'nothing created by this journey is left in the database',
    );
  });
}
