import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { config } from '../src/config/env.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { AppError } from '../src/utils/AppError.js';

let server;
let baseUrl;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('unknown route returns a JSON 404', async () => {
  const res = await fetch(`${baseUrl}/api/does-not-exist`);
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.success, false);
  assert.match(body.error.message, /Route not found/);
});

test('malformed JSON body returns 400, not a crash or stack trace', async () => {
  const res = await fetch(`${baseUrl}/api/health`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"broken": ',
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.message, 'Request body is not valid JSON.');
  assert.equal(body.error.stack, undefined);
});

test('oversized body returns 413', async () => {
  const res = await fetch(`${baseUrl}/api/health`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filler: 'x'.repeat(200 * 1024) }),
  });
  assert.equal(res.status, 413);
});

test('CORS allows the configured client origin only', async () => {
  const allowed = await fetch(`${baseUrl}/api/health`, { headers: { Origin: config.clientOrigin } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), config.clientOrigin);

  const blocked = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'http://evil.example' } });
  assert.notEqual(blocked.headers.get('access-control-allow-origin'), 'http://evil.example');
});

test('server does not advertise it is Express', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.headers.get('x-powered-by'), null);
});

// --- errorHandler unit tests (fake response object) ---
function runHandler(error) {
  const result = { status: null, body: null };
  const res = {
    headersSent: false,
    status(code) { result.status = code; return this; },
    json(payload) { result.body = payload; return this; },
  };
  const originalLog = console.error;
  console.error = () => {}; // keep test output clean
  try {
    errorHandler(error, {}, res, () => {});
  } finally {
    console.error = originalLog;
  }
  return result;
}

test('errorHandler uses the status code from AppError', () => {
  const { status, body } = runHandler(new AppError('Subject not found', 404));
  assert.equal(status, 404);
  assert.deepEqual(body, { success: false, error: { message: 'Subject not found' } });
});

test('errorHandler hides internal details of unexpected errors', () => {
  const { status, body } = runHandler(new Error('secret internal detail mongodb://user:pw@host'));
  assert.equal(status, 500);
  assert.equal(body.error.message, 'Something went wrong on the server.');
  assert.doesNotMatch(JSON.stringify(body), /secret|mongodb|stack/i);
});

test('errorHandler turns DocumentNotFoundError (deleted mid-request) into 404', () => {
  const { status, body } = runHandler(Object.assign(new Error('gone'), { name: 'DocumentNotFoundError' }));
  assert.equal(status, 404);
  assert.equal(body.error.message, 'Record not found.');
});

test('errorHandler turns a duplicate-key error into 409', () => {
  const { status } = runHandler(Object.assign(new Error('dup'), { code: 11000 }));
  assert.equal(status, 409);
});

test('errorHandler turns a Mongoose CastError into 400', () => {
  const error = Object.assign(new Error('cast'), { name: 'CastError', path: '_id' });
  const { status, body } = runHandler(error);
  assert.equal(status, 400);
  assert.match(body.error.message, /Invalid value for "_id"/);
});
