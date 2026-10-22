// Small helpers shared by the browser specs.
export const pad = (n) => String(n).padStart(2, '0');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A date relative to today on THIS computer, as YYYY-MM-DD (the browser uses the same clock and time zone).
export function ymd(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Polls until check() is truthy, or fails with a clear message.
export async function eventually(check, message, timeout = 7000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${message}${last ? ` (${last.message})` : ''}`);
}

// A small RFC 4180 reader: what a spreadsheet would read back from a CSV file (quotes, commas and line breaks inside cells).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}
