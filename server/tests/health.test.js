import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

let server;
let baseUrl;

before(async () => {
  server = createApp().listen(0); // port 0 = pick any free port
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('GET /api/health reports server up and database disconnected when no DB is connected', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.server, 'up');
  assert.equal(body.data.database, 'disconnected');
  assert.equal(body.data.status, 'degraded');
  assert.equal(typeof body.data.uptimeSeconds, 'number');
});

test('health response never contains secrets or connection strings', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  const text = await res.text();
  assert.doesNotMatch(text, /mongodb/i);
  assert.doesNotMatch(text, /password/i);
});
