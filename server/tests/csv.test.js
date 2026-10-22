import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../src/utils/csv.js';
import { weekRange } from '../src/utils/dates.js';
import { parseReportQuery } from '../src/validators/reportQueryValidator.js';
import { parseWeekStartQuery } from '../src/validators/queryHelpers.js';

describe('CSV cells (no database needed)', () => {
  test('plain text and numbers are written as they are', () => {
    assert.equal(csvCell('Maths essay'), 'Maths essay');
    assert.equal(csvCell(45), '45');
    assert.equal(csvCell(0), '0');
    assert.equal(csvCell(-5), '-5', 'a real negative NUMBER is not a formula');
    assert.equal(csvCell(''), '');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
    assert.equal(csvCell(Number.NaN), '');
    assert.equal(csvCell(true), 'Yes');
    assert.equal(csvCell(false), 'No');
  });

  test('commas, quotes and line breaks are quoted, and quotes are doubled', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
    assert.equal(csvCell('line1\r\nline2'), '"line1\r\nline2"');
    assert.equal(csvCell('"'), '""""');
    assert.equal(csvCell(' padded '), '" padded "', 'leading/trailing spaces survive');
  });

  test('text that starts like a spreadsheet formula gets a leading apostrophe', () => {
    for (const text of ['=1+1', '+1', '-1+2', '@SUM(A1)', '=HYPERLINK("http://x","y")', '\t=1', '\r=1', ' =1+1', '  @x', '-cmd|\' /C calc\'!A0']) {
      const cell = csvCell(text);
      const inner = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
      assert.equal(inner, `'${text}`, JSON.stringify(text));
    }
  });

  test('text that merely CONTAINS those characters later is left alone', () => {
    assert.equal(csvCell('a=b'), 'a=b');
    assert.equal(csvCell('x+y'), 'x+y');
    assert.equal(csvCell('mail@example.com'), 'mail@example.com');
    assert.equal(csvCell('2026-10-21'), '2026-10-21', 'a plain date starts with a digit');
    assert.equal(csvCell('11:30'), '11:30');
  });

  test('accents and emoji pass through unchanged', () => {
    assert.equal(csvCell('Zoë étude 学习 📚'), 'Zoë étude 学习 📚');
  });

  test('toCsv: header row, CRLF line ends, a final line break, and an empty list gives only the header', () => {
    const columns = [{ label: 'Name', value: (r) => r.name }, { label: 'Minutes', value: (r) => r.minutes }];
    assert.equal(toCsv(columns, [{ name: 'a,b', minutes: 5 }, { name: '=x', minutes: 0 }]), 'Name,Minutes\r\n"a,b",5\r\n\'=x,0\r\n');
    assert.equal(toCsv(columns, []), 'Name,Minutes\r\n');
  });
});

describe('week start (no database needed)', () => {
  test('a Sunday-start week runs Sunday to Saturday', () => {
    for (const day of ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']) {
      assert.deepEqual(weekRange(day, 'sunday'), { from: '2026-10-18', to: '2026-10-24' }, day);
    }
    assert.deepEqual(weekRange('2026-10-25', 'sunday'), { from: '2026-10-25', to: '2026-10-31' }, 'a Sunday starts its own week');
  });

  test('Sunday-start weeks across a year end and a leap day', () => {
    assert.deepEqual(weekRange('2027-01-01', 'sunday'), { from: '2026-12-27', to: '2027-01-02' });
    assert.deepEqual(weekRange('2028-02-29', 'sunday'), { from: '2028-02-27', to: '2028-03-04' });
  });

  test('Monday stays the default, and an unknown value falls back to Monday', () => {
    assert.deepEqual(weekRange('2026-10-21'), { from: '2026-10-19', to: '2026-10-25' });
    assert.deepEqual(weekRange('2026-10-21', 'monday'), { from: '2026-10-19', to: '2026-10-25' });
    assert.deepEqual(weekRange('2026-10-21', undefined), { from: '2026-10-19', to: '2026-10-25' });
  });

  test('parseWeekStartQuery: monday by default, sunday allowed, anything else is a 400', () => {
    assert.equal(parseWeekStartQuery({}), 'monday');
    assert.equal(parseWeekStartQuery({ weekStart: 'sunday' }), 'sunday');
    assert.equal(parseWeekStartQuery({ weekStart: '' }), 'monday');
    for (const bad of ['Sunday', 'saturday', '0', 'monday,sunday', ['sunday'], { $ne: 'x' }]) {
      assert.throws(() => parseWeekStartQuery({ weekStart: bad }), (error) => error.statusCode === 400, JSON.stringify(bad));
    }
  });
});

describe('report query validation (no database needed)', () => {
  const NOW = '2026-10-21T14:30';
  const parse = (query, options) => parseReportQuery({ now: NOW, ...query }, options);
  const fails = (query, field, options) =>
    assert.throws(
      () => parse(query, options),
      (error) => error.statusCode === 400 && (field === undefined || error.details?.some((d) => d.field === field)),
      JSON.stringify(query),
    );

  test('every filter is optional: no filters means all time, all subjects', () => {
    const parsed = parse({});
    assert.equal(parsed.from, undefined);
    assert.equal(parsed.to, undefined);
    assert.equal(parsed.subject, undefined);
    assert.equal(parsed.weekStart, 'monday');
  });

  test('a range may be open at one end, but must be in order and made of real dates', () => {
    assert.equal(parse({ from: '2026-10-01' }).from, '2026-10-01');
    assert.equal(parse({ to: '2026-10-31' }).to, '2026-10-31');
    assert.doesNotThrow(() => parse({ from: '2026-10-05', to: '2026-10-05' }));
    fails({ from: '2026-10-06', to: '2026-10-05' });
    for (const bad of ['2026-02-30', 'abc', '2026-10-1', ['2026-10-01'], { $gte: 'x' }]) {
      fails({ from: bad }, 'from');
      fails({ to: bad }, 'to');
    }
  });

  test('subject must be an id; weekStart and now are validated too', () => {
    assert.equal(parse({ subject: '64b7f0c2a1b2c3d4e5f60718' }).subject.toString(), '64b7f0c2a1b2c3d4e5f60718');
    for (const bad of ['abc', 'none', '64b7f0c2a1b2c3d4e5f6071g']) fails({ subject: bad }, 'subject');
    fails({ weekStart: 'friday' }, 'weekStart');
    fails({ now: 'tomorrow' }, 'now');
  });

  test('exports need a known type', () => {
    for (const type of ['assignments', 'tasks', 'study-sessions']) assert.equal(parse({ type }, { exporting: true }).type, type);
    fails({}, 'type', { exporting: true });
    for (const bad of ['sessions', 'Tasks', 'all', ['tasks', 'assignments']]) fails({ type: bad }, 'type', { exporting: true });
    assert.equal(parse({ type: 'ignored' }).type, undefined, 'the summary does not read "type"');
  });
});
