import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_EVENTS_PER_TYPE } from '../src/controllers/calendarController.js';
import { MAX_EXPORT_ROWS } from '../src/controllers/reportController.js';
import { MAX_RANGE_DAYS } from '../src/validators/calendarQueryValidator.js';

// Keeps README.md honest: what it says about commands, settings, API routes and limits must match the project.
// (No database is used; nothing here reads server/.env.)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const readme = read('README.md');
const json = (...parts) => JSON.parse(read(...parts));

describe('README matches the project (no database needed)', () => {
  test('it has every section the project plan asks for', () => {
    const headings = [...readme.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].toLowerCase());
    for (const wanted of ['features', 'technologies', 'folder structure', 'prerequisites', 'quick start', 'environment variables',
      'commands', 'api', 'testing', 'troubleshooting', 'known limitations', 'suggested next steps']) {
      assert.ok(headings.some((heading) => heading.includes(wanted)), `README is missing a "${wanted}" section`);
    }
    assert.ok(headings.some((heading) => heading.includes('database')), 'README explains the database setup');
    const plain = readme.replace(/[*_`>]/g, '').replace(/\s+/g, ' '); // without bold marks, quote marks and line breaks
    assert.match(plain, /not a secure multi-user production application/i, 'README says plainly that this is a local demo');
    assert.match(plain, /no login and no per-user data/i);
  });

  test('every npm command it shows exists in a package.json', () => {
    const scripts = { '': json('package.json').scripts };
    for (const folder of ['server', 'client', 'e2e']) scripts[folder] = json(folder, 'package.json').scripts;
    const notScripts = new Set(['audit', 'install', 'ci', 'view', 'ls']);
    const commands = [...readme.matchAll(/\bnpm (run )?([a-z][a-z0-9:-]*)((?: --prefix (server|client|e2e))?)/g)];
    assert.ok(commands.length >= 10, 'the README shows npm commands');
    for (const [full, run, script, , prefix] of commands) {
      if (!run && notScripts.has(script)) continue; // "npm audit", "npm install"
      if (!run && !['test', 'start'].includes(script)) continue; // prose such as "npm package"
      const folder = prefix ?? '';
      assert.ok(scripts[folder]?.[script], `README shows "${full.trim()}", but ${folder || 'the root'} package.json has no "${script}" script`);
    }
  });

  test('every setting in .env.example, in the server config and in the tooling is explained', () => {
    const fromExample = [...read('server', '.env.example').matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]);
    const fromConfig = [...read('server', 'src', 'config', 'env.js').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((match) => match[1]);
    const others = ['API_PROXY_TARGET', 'CHROME_PATH'];
    assert.ok(fromExample.length >= 5);
    for (const name of new Set([...fromExample, ...fromConfig, ...others])) {
      assert.ok(readme.includes(`\`${name}\``), `README does not explain ${name}`);
    }
    assert.ok(read('client', 'vite.config.js').includes('API_PROXY_TARGET'), 'API_PROXY_TARGET is really used by the client');
    assert.ok(read('e2e', 'run.mjs').includes('CHROME_PATH'), 'CHROME_PATH is really used by the browser tests');
  });

  test('the API table lists exactly the routes the server has', () => {
    const app = read('server', 'src', 'app.js');
    const importedAs = Object.fromEntries([...app.matchAll(/import (\w+) from '\.\/routes\/([\w-]+)\.js'/g)].map((match) => [match[1], match[2]]));
    const actual = new Set();
    for (const [, prefix, variable] of app.matchAll(/app\.use\('(\/api[^']*)',\s*(\w+)\)/g)) {
      const file = read('server', 'src', 'routes', `${importedAs[variable]}.js`);
      for (const [, method, route] of file.matchAll(/router\.(get|post|put|patch|delete)\('([^']*)'/g)) {
        actual.add(`${method.toUpperCase()} ${prefix}${route === '/' ? '' : route}`);
      }
    }
    assert.ok(actual.size >= 25, 'the routes were read from the code');

    const documented = new Set([...readme.matchAll(/^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`(\/api[^`]*)`/gm)].map((match) => `${match[1]} ${match[2]}`));
    assert.deepEqual([...actual].filter((route) => !documented.has(route)).sort(), [], 'routes missing from the README table');
    assert.deepEqual([...documented].filter((route) => !actual.has(route)).sort(), [], 'README documents routes that do not exist');
  });

  test('every link to a section inside the README points at a real heading', () => {
    // GitHub-style anchors: lower case, punctuation removed, spaces become hyphens
    const slug = (heading) => heading.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-');
    const anchors = new Set([...readme.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1])));
    const links = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]);
    assert.ok(links.length >= 10, 'the README has a contents list');
    for (const link of links) assert.ok(anchors.has(link), `README links to #${link}, but no heading has that anchor`);
  });

  test('the numeric limits it states are the real ones', () => {
    assert.equal(MAX_EXPORT_ROWS, 10000);
    assert.equal(MAX_RANGE_DAYS, 62);
    assert.equal(MAX_EVENTS_PER_TYPE, 500);
    assert.ok(readme.includes('10,000 rows'), 'export row limit');
    assert.ok(readme.includes(`at most ${MAX_RANGE_DAYS} days`), 'calendar range limit');
    assert.ok(readme.includes(`${MAX_EVENTS_PER_TYPE} events`), 'calendar events limit');
    assert.ok(readme.includes('up to 200'), 'page size limit');
    assert.match(readme, /2000-01-01 and 2100-12-31/, 'date range');
  });

  test('every file or folder it names exists (except ones created by you or by a build)', () => {
    const created = new Set(['server/.env', 'client/dist']);
    const named = new Set([...readme.matchAll(/`((?:docs|server|client|e2e)\/[\w./-]+)`/g)].map((match) => match[1].replace(/\/$/, '')));
    assert.ok(named.size >= 5);
    for (const file of named) {
      if (created.has(file) || file.endsWith('/')) continue;
      assert.ok(fs.existsSync(path.join(ROOT, file)), `README mentions ${file}, which does not exist`);
    }
    for (const required of ['docs/architecture-notes.md', 'e2e/README.md', 'server/.env.example']) {
      assert.ok(readme.includes(required), `README points to ${required}`);
    }
  });

  test('it contains no credentials: connection strings use placeholders only', () => {
    assert.doesNotMatch(readme, /mongodb(\+srv)?:\/\/[^\s'"`<>/]+:[^\s'"`<>@/]+@/i, 'README contains what looks like a database login');
    assert.match(readme, /<db-user>:<db-password>@<cluster-host>/);
    assert.match(readme, /\.env.*git-ignored/s);
  });

  test('it states the replica-set requirement and the open audit finding accurately', () => {
    assert.match(readme, /replica set/i);
    assert.match(readme, /transactions/i);
    assert.match(readme, /studyflow_test/);
    // the finding is described as OPEN, with the real package chain, and never as fixed
    assert.match(readme, /nodemon[^\n]*chokidar[^\n]*braces/);
    assert.match(readme, /GHSA-vfj7-8cjw-p6xm/);
    assert.match(readme, /not fixed/i);
    assert.match(readme, /npm audit --omit=dev[^\n]*0/);
    assert.doesNotMatch(readme, /(vulnerabilit\w+|finding)[^\n.]*\b(is|was|has been) (fixed|resolved)\b/i);
    const installed = json('server', 'node_modules', 'nodemon', 'package.json').version;
    assert.ok(readme.includes(`\`nodemon\` ${installed}`), `README names the installed nodemon version (${installed})`);
  });

  test('the sub-READMEs exist and are not leftover template text', () => {
    assert.doesNotMatch(read('client', 'README.md'), /This template provides a minimal setup/);
    assert.match(read('e2e', 'README.md'), /StudyFlow browser tests/);
  });
});
