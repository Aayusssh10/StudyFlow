import assert from 'node:assert/strict';

export const name = 'Subjects page';

export default async function run(t) {
  const { app, db, N, step, shot, api } = t;
  const page = await t.newPage();
  const col = db.col;

  const go = async (url) => { await page.goto(url); await page.waitForLoadState('networkidle'); };
  const reload = async () => { await page.reload(); await page.waitForLoadState('networkidle'); };
  const addBtn = () => page.getByRole('button', { name: 'Add subject', exact: true });
  const submitBtn = () => page.getByRole('button', { name: 'Add subject', exact: true });
  const card = (text) => page.locator('li.subject-card', { hasText: text });
  const text = (value) => page.getByText(value, { exact: false });
  const subjectsByTag = () => col('subjects').find({ name: { $regex: `^${t.tag}_`, $options: 'i' } }).toArray();
  const SUBJECTS_URL = /\/api\/subjects(\?.*)?$/;

  async function fillForm({ name: subjectName, code, instructor, description }) {
    if (subjectName !== undefined) await page.getByLabel('Name').fill(subjectName);
    if (code !== undefined) await page.getByLabel('Code (optional)').fill(code);
    if (instructor !== undefined) await page.getByLabel('Instructor (optional)').fill(instructor);
    if (description !== undefined) await page.getByLabel('Description (optional)').fill(description);
  }

  await step('S1', 'Loading state is shown while subjects load (delayed response)', async () => {
    await page.route(SUBJECTS_URL, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      try { await route.continue(); } catch { /* page already moved on */ }
    });
    await page.goto(`${app}/subjects`);
    await text('Loading subjects...').waitFor({ timeout: 1200 });
    await text('No subjects yet').waitFor();
    await page.unroute(SUBJECTS_URL);
  });

  await step('S2', 'Empty state is shown, with a working call-to-action', async () => {
    await shot(page, 'subjects-01-empty');
    await page.getByRole('button', { name: 'Add your first subject' }).click();
    await page.getByRole('heading', { name: 'Add a subject' }).waitFor();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('heading', { name: 'Add a subject' }).waitFor({ state: 'detached' });
  });

  await step('S3', 'Required-field validation shows a message and sends no request', async () => {
    let posts = 0;
    const count = (request) => { if (request.method() === 'POST') posts += 1; };
    page.on('request', count);
    await addBtn().click();
    await submitBtn().click();
    await page.locator('#subject-name-error').waitFor();
    assert.equal(await page.locator('#subject-name-error').innerText(), 'Subject name is required.');
    assert.equal(await page.getByLabel('Name').getAttribute('aria-invalid'), 'true');
    await page.getByLabel('Name').fill('     ');
    await submitBtn().click();
    assert.equal(await page.locator('#subject-name-error').innerText(), 'Subject name is required.');
    page.off('request', count);
    assert.equal(posts, 0, 'no POST should be sent for invalid input');
    assert.equal((await subjectsByTag()).length, 0);
    await shot(page, 'subjects-02-validation');
  });

  await step('S4', 'A valid subject can be created and appears in the list', async () => {
    await fillForm({ name: N('Mathematics'), code: 'MATH101', instructor: 'Dr. Rao', description: 'Calculus and algebra' });
    await submitBtn().click();
    await text('Subject added.').waitFor();
    await card(N('Mathematics')).waitFor();
    assert.match(await card(N('Mathematics')).innerText(), /MATH101/);
    assert.match(await card(N('Mathematics')).innerText(), /Dr\. Rao/);
    const stored = await subjectsByTag();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].code, 'MATH101');
  });

  await step('S5', 'A duplicate name (different letter case) is rejected with a visible message', { provoked: true }, async () => {
    await addBtn().click();
    await fillForm({ name: N('Mathematics').toUpperCase() });
    await submitBtn().click();
    await page.getByRole('alert').filter({ hasText: 'already exists' }).waitFor();
    await page.locator('.field-error').first().waitFor();
    assert.equal((await subjectsByTag()).length, 1, 'no duplicate stored');
    assert.ok(await page.getByRole('heading', { name: 'Add a subject' }).isVisible(), 'form stays open so the user can fix the name');
    assert.ok(await submitBtn().isEnabled(), 'submit button is usable again');
    await shot(page, 'subjects-03-duplicate');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('S6', 'The list loads several subjects in alphabetical order after a reload', async () => {
    assert.equal((await api('POST', '/subjects', { name: N('Biology'), color: '#00aa00' })).status, 201);
    assert.equal((await api('POST', '/subjects', { name: N('Chemistry') })).status, 201);
    await reload();
    await card(N('Chemistry')).waitFor();
    assert.deepEqual(await page.locator('li.subject-card h2').allInnerTexts(), [N('Biology'), N('Chemistry'), N('Mathematics')]);
    const color = await card(N('Biology')).evaluate((el) => getComputedStyle(el).getPropertyValue('--subject-color').trim());
    assert.equal(color, '#00aa00');
    await shot(page, 'subjects-04-list');
  });

  await step('S7', 'An existing subject can be edited; the change shows and persists after reload', async () => {
    await card(N('Mathematics')).getByRole('button', { name: /^Edit/ }).click();
    await page.getByRole('heading', { name: 'Edit subject' }).waitFor();
    assert.equal(await page.getByLabel('Name').inputValue(), N('Mathematics'), 'form is pre-filled');
    await fillForm({ name: N('Advanced Math'), instructor: 'Prof. Iyer' });
    await page.getByRole('button', { name: 'Save changes' }).click();
    await text('Subject updated.').waitFor();
    await card(N('Advanced Math')).waitFor();
    assert.equal(await card(N('Mathematics')).count(), 0, 'old name is gone');
    await reload();
    await card(N('Advanced Math')).waitFor();
    assert.match(await card(N('Advanced Math')).innerText(), /Prof\. Iyer/);
  });

  await step('S8', 'Delete asks for confirmation; Cancel and Escape keep the subject; Confirm deletes it', async () => {
    const target = card(N('Chemistry'));
    await target.getByRole('button', { name: /^Delete/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), new RegExp(`Delete "${N('Chemistry')}"\\?`));
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await target.count(), 1, 'Cancel keeps the subject');

    await target.getByRole('button', { name: /^Delete/ }).click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await target.count(), 1, 'Escape keeps the subject');

    await target.getByRole('button', { name: /^Delete/ }).click();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await text(`Deleted "${N('Chemistry')}".`).waitFor();
    await target.waitFor({ state: 'detached' });
    assert.equal((await subjectsByTag()).filter((s) => s.name === N('Chemistry')).length, 0);
  });

  await step('S9', 'Deleting a subject that a real assignment uses is blocked, with an explanation', { provoked: true }, async () => {
    const biology = (await subjectsByTag()).find((s) => s.name === N('Biology'));
    const made = await api('POST', '/assignments', { title: N('Biology homework'), dueDate: '2030-01-15', subject: biology._id.toString() });
    assert.equal(made.status, 201);

    await card(N('Biology')).getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Cannot delete' });
    await alert.waitFor();
    assert.match(await alert.innerText(), /still used by 1 assignment/);
    assert.equal(await card(N('Biology')).count(), 1, 'still listed');
    assert.equal(await col('subjects').countDocuments({ _id: biology._id }), 1, 'still in the database');
    assert.equal(await col('assignments').countDocuments({ subject: biology._id }), 1, 'assignment untouched');
    await page.getByRole('dialog').waitFor({ state: 'hidden' }); // it closes a moment after the message appears
    await shot(page, 'subjects-05-delete-blocked');
    await reload();
    await card(N('Biology')).waitFor();
  });

  await step('S10', 'A list request failing with HTTP 500 shows an error and "Try again" recovers', { provoked: true }, async () => {
    await page.route(SUBJECTS_URL, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Something went wrong on the server.' } }) }));
    await reload();
    await page.getByRole('alert').filter({ hasText: 'Something went wrong on the server.' }).waitFor();
    await page.unroute(SUBJECTS_URL);
    await page.getByRole('button', { name: 'Try again' }).click();
    await card(N('Biology')).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0, 'error notice is gone after recovery');
  });

  await step('S11', 'Server unreachable (network failure) shows a friendly message', { provoked: true }, async () => {
    await page.route(SUBJECTS_URL, (route) => route.abort('connectionrefused'));
    await reload();
    await page.getByRole('alert').filter({ hasText: 'Cannot reach the StudyFlow server' }).waitFor();
    await page.unroute(SUBJECTS_URL);
  });

  await step('S12', 'Server-side validation errors (HTTP 400 with details) are shown next to the fields', { provoked: true }, async () => {
    await reload();
    await card(N('Biology')).waitFor();
    const POST_ONLY = /\/api\/subjects$/;
    await page.route(POST_ONLY, (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Validation failed.', details: [{ field: 'name', message: 'Name from server.' }, { field: 'code', message: 'Code from server.' }] } }) })
      : route.continue());
    await addBtn().click();
    await fillForm({ name: N('Mocked') });
    await submitBtn().click();
    await page.getByRole('alert').filter({ hasText: 'Validation failed.' }).waitFor();
    assert.equal(await page.locator('#subject-name-error').innerText(), 'Name from server.');
    await text('Code from server.').waitFor();
    await page.unroute(POST_ONLY);
    assert.equal((await subjectsByTag()).filter((s) => s.name === N('Mocked')).length, 0);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('S13', 'A failed save (HTTP 500) keeps the form open, keeps the typed text and re-enables the button', { provoked: true }, async () => {
    const POST_ONLY = /\/api\/subjects$/;
    await page.route(POST_ONLY, (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Something went wrong on the server.' } }) })
      : route.continue());
    await addBtn().click();
    await fillForm({ name: N('Mocked2') });
    await submitBtn().click();
    await page.getByRole('alert').filter({ hasText: 'Something went wrong' }).waitFor();
    assert.equal(await page.getByLabel('Name').inputValue(), N('Mocked2'));
    assert.ok(await submitBtn().isEnabled());
    await page.unroute(POST_ONLY);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('S14', 'A failed delete (network error) shows an error, closes the dialog and keeps the subject', { provoked: true }, async () => {
    const ITEM = /\/api\/subjects\/[0-9a-f]{24}$/;
    await page.route(ITEM, (route) => route.request().method() === 'DELETE' ? route.abort('connectionrefused') : route.continue());
    await card(N('Biology')).getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Cannot reach the StudyFlow server' }).waitFor();
    await page.getByRole('dialog').waitFor({ state: 'hidden' }); // it closes a moment after the message appears
    assert.equal(await card(N('Biology')).count(), 1);
    await page.unroute(ITEM);
  });

  await step('S15', 'Desktop: sidebar visible, mobile menu hidden, all 8 nav links navigate', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await go(`${app}/subjects`);
    await card(N('Biology')).waitFor();
    assert.ok(await page.locator('#sidebar').isVisible());
    assert.equal(await page.locator('.mobile-bar').isVisible(), false);
    const routes = { Dashboard: '/', Subjects: '/subjects', Assignments: '/assignments', 'Daily tasks': '/tasks', Calendar: '/calendar', 'Study sessions': '/study-sessions', Reports: '/reports', Settings: '/settings' };
    for (const [label, route] of Object.entries(routes)) {
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: label }).click();
      await page.waitForURL(`${app}${route}`);
      if (label === 'Subjects') await card(N('Biology')).waitFor(); // let this page's request finish before leaving it
      if (label === 'Assignments') await page.locator('#filter-q').waitFor();
      if (label === 'Daily tasks') await page.locator('#task-filter-q').waitFor();
      if (label === 'Study sessions') await page.locator('#session-filter-q').waitFor();
      assert.equal(await page.locator('main h1').count(), 1, `${label} page renders a heading`);
    }
    await page.waitForLoadState('networkidle');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll');
  });

  await step('S16', 'Mobile (375px): menu opens/closes, links are on screen, link click closes it, no horizontal scroll', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await go(`${app}/subjects`);
    await card(N('Biology')).waitFor();
    assert.ok(await page.locator('.mobile-bar').isVisible());
    assert.equal(await page.locator('#sidebar').isVisible(), false, 'menu is hidden initially');
    const toggle = page.getByRole('button', { name: 'Open menu' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    await page.locator('#sidebar').waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded'), 'true');
    await page.waitForFunction(() => ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(document.querySelector('#sidebar')).transform));
    for (const label of ['Dashboard', 'Subjects', 'Assignments', 'Daily tasks', 'Calendar', 'Study sessions', 'Reports', 'Settings']) {
      const box = await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: label }).boundingBox();
      assert.ok(box.y >= 61 && box.y + box.height <= 812, `${label} link is on screen below the top bar (y=${box.y})`);
    }
    await shot(page, 'subjects-06-mobile-menu');
    await page.getByRole('button', { name: 'Close menu' }).click();
    await page.locator('#sidebar').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Assignments' }).click();
    await page.waitForURL(`${app}/assignments`);
    await page.locator('#filter-q').waitFor();
    await page.locator('#sidebar').waitFor({ state: 'hidden' });
    await go(`${app}/subjects`);
    await card(N('Biology')).waitFor();
    await addBtn().click();
    await page.getByRole('heading', { name: 'Add a subject' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll with the form open');
    const nameBox = await page.getByLabel('Name').boundingBox();
    const codeBox = await page.getByLabel('Code (optional)').boundingBox();
    assert.ok(codeBox.y > nameBox.y, 'form fields stack in one column');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('S17', 'Keyboard: skip link is the first Tab stop; form fields have labels; the name field gets focus', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await go(`${app}/subjects`);
    await card(N('Biology')).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Skip to main content');
    await addBtn().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Add a subject' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'subject-name');
    for (const label of ['Name', 'Code (optional)', 'Instructor (optional)', 'Color', 'Description (optional)']) {
      assert.equal(await page.getByLabel(label).count(), 1, `label "${label}"`);
    }
    const colorBox = await page.getByLabel('Color').boundingBox();
    assert.ok(colorBox.width <= 100, `color picker is a small swatch (${colorBox.width}px)`);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('S18', 'A 100-character name wraps inside its card on mobile; HTML in a name is shown as text (XSS check)', async () => {
    const longName = N('').padEnd(100, 'W');
    const evil = N('<img src=x onerror=window.__xss=1>');
    assert.equal((await api('POST', '/subjects', { name: longName, code: 'LONG1' })).status, 201);
    assert.equal((await api('POST', '/subjects', { name: evil })).status, 201);

    await page.setViewportSize({ width: 375, height: 812 });
    await go(`${app}/subjects`);
    const longCard = card(longName);
    await longCard.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll');
    const cardBox = await longCard.boundingBox();
    const titleBox = await longCard.locator('h2').boundingBox();
    assert.ok(titleBox.x + titleBox.width <= cardBox.x + cardBox.width + 1, 'title stays inside the card');
    const dotBox = await longCard.locator('.color-dot').boundingBox();
    assert.ok(dotBox.y < titleBox.y + 30, 'color dot sits beside the first line of the title');
    await shot(page, 'subjects-07-mobile-long-name');

    await card('<img src=x onerror=window.__xss=1>').waitFor();
    assert.equal(await page.locator('li.subject-card img').count(), 0, 'no <img> element was created');
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'injected handler never ran');
  });
}
