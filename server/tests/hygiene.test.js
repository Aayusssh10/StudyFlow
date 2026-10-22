import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Project-wide checks that need no database: no leftover debug code, no credentials in source files,
// placeholders only in .env.example, secrets git-ignored, and no unused runtime dependencies.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git', 'screenshots', 'coverage']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.json', '.md']);

function walk(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

const relative = (file) => path.relative(ROOT, file).replace(/\\/g, '/');
const files = walk(ROOT).filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)) && !file.endsWith('package-lock.json'));
const read = (file) => fs.readFileSync(file, 'utf8');
const sourceOf = (prefix) => files.filter((file) => relative(file).startsWith(prefix) && /\.(jsx?|mjs)$/.test(file));

describe('project hygiene (no database needed)', () => {
  test('the scan really covers the project (guards against an empty walk)', () => {
    assert.ok(sourceOf('client/src/').length > 30, 'client source files');
    assert.ok(sourceOf('server/src/').length > 20, 'server source files');
    assert.ok(sourceOf('e2e/').length > 5, 'browser test files');
  });

  test('the browser app contains no console calls and no debugger statements', () => {
    for (const file of sourceOf('client/src/')) {
      const text = read(file);
      assert.doesNotMatch(text, /\bconsole\.\w+\s*\(/, `${relative(file)} calls console`);
      assert.doesNotMatch(text, /\bdebugger\b/, `${relative(file)} has a debugger statement`);
    }
  });

  test('the server only logs where it is intended to (start-up messages and server-side error logging)', () => {
    const allowed = new Map([
      ['server/src/server.js', /console\.log\(/],
      ['server/src/middleware/errorHandler.js', /console\.error\(/],
      ['server/scripts/check-integrity.js', /console\.log\(/],
    ]);
    for (const file of [...sourceOf('server/src/'), ...sourceOf('server/scripts/')]) {
      const name = relative(file);
      const text = read(file);
      assert.doesNotMatch(text, /\bdebugger\b/, `${name} has a debugger statement`);
      const calls = text.match(/\bconsole\.\w+\s*\(/g) ?? [];
      if (calls.length > 0) assert.ok(allowed.has(name), `${name} logs to the console but is not on the allowed list: ${calls[0]}`);
    }
  });

  test('no focused or skipped-by-accident tests are left in the test files', () => {
    for (const file of [...sourceOf('server/tests/'), ...sourceOf('e2e/')]) {
      if (relative(file) === 'server/tests/hygiene.test.js') continue;
      assert.doesNotMatch(read(file), /\b(test|describe|it)\.only\s*\(/, `${relative(file)} has a .only`);
    }
  });

  test('no connection string with a username and password in any source file (only the fake ones in tests)', () => {
    const withCredentials = /mongodb(\+srv)?:\/\/[^\s'"`<>/]+:[^\s'"`<>@/]+@/i;
    const fakeOnes = new Set(['server/tests/db.test.js', 'server/tests/errors.test.js']);
    for (const file of files) {
      const name = relative(file);
      if (name.endsWith('.env.example') || fakeOnes.has(name)) continue;
      assert.doesNotMatch(read(file), withCredentials, `${name} contains what looks like a database login`);
    }
  });

  test('.env.example holds placeholders only', () => {
    const text = read(path.join(ROOT, 'server', '.env.example'));
    const uris = text.split(/\r?\n/).filter((line) => /^MONGODB\w*URI=/.test(line));
    assert.equal(uris.length, 2, 'both database variables are listed');
    for (const line of uris) {
      assert.match(line, /<db-user>:<db-password>@<cluster-host>/, 'the login is a placeholder');
    }
  });

  test('secret files are git-ignored (.env, .env.*, server/.env) while .env.example stays tracked', () => {
    const ignore = read(path.join(ROOT, '.gitignore')).split(/\r?\n/).map((line) => line.trim());
    for (const rule of ['.env', '.env.*', 'server/.env', '!.env.example', 'node_modules/', 'dist/']) {
      assert.ok(ignore.includes(rule), `.gitignore is missing "${rule}"`);
    }
  });

  test('every runtime dependency of the client and server is actually imported', () => {
    for (const [folder, prefix] of [['client', 'client/src/'], ['server', 'server/src/']]) {
      const { dependencies = {} } = JSON.parse(read(path.join(ROOT, folder, 'package.json')));
      const code = sourceOf(prefix).map(read).join('\n');
      for (const name of Object.keys(dependencies)) {
        const imported = new RegExp(`from\\s+['"]${name}(/[^'"]*)?['"]|import\\s*\\(\\s*['"]${name}|require\\(\\s*['"]${name}`).test(code);
        assert.ok(imported, `${folder} depends on "${name}" but never imports it`);
      }
    }
  });
});
