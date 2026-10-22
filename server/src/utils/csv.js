// CSV for the report exports (RFC 4180 style: comma separated, CRLF line ends, quotes doubled).
//
// Spreadsheet programs run a cell that STARTS with = + - @ (or a tab / carriage return) as a formula, so text
// like "=HYPERLINK(...)" typed into a title would run when the file is opened. Such text cells get a leading
// apostrophe, which makes the program show them as plain text. Real numbers are written as they are.
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  let text = String(value);
  if (FORMULA_START.test(text.trimStart())) text = `'${text}`;
  if (NEEDS_QUOTES.test(text) || text !== text.trim()) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

// `columns` is [{ label, value: (row) => ... }]. The first line is the header.
export function toCsv(columns, rows) {
  const lines = [columns.map((column) => csvCell(column.label)).join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(column.value(row))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
