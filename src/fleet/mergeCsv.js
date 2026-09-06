/**
 * Merge per-instance CCI CSVs, dedupe by url, return { header, lines } or write to disk.
 */

import fs from 'fs/promises';
import path from 'path';

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;

  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function serializeCsvRow(fields) {
  return fields
    .map((f) => {
      const s = f == null ? '' : String(f);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    })
    .join(',');
}

/**
 * @param {string[]} csvPaths
 * @returns {Promise<{ header: string, body: string, recordCount: number }>}
 */
export async function mergeCsvFiles(csvPaths) {
  let header = null;
  const seen = new Set();
  const outRows = [];

  for (const csvPath of csvPaths) {
    let text;
    try {
      text = await fs.readFile(csvPath, 'utf8');
    } catch {
      continue;
    }
    if (!text.trim()) continue;

    const rows = parseCsvRows(text);
    if (!rows.length) continue;

    if (!header) header = rows[0];
    const urlIdx = header.indexOf('url');

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row.length || row.every((c) => c === '')) continue;
      const key = urlIdx >= 0 ? (row[urlIdx] || `row-${outRows.length}`) : JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      outRows.push(row);
    }
  }

  if (!header) {
    return { header: '', body: '', recordCount: 0 };
  }

  const lines = [serializeCsvRow(header), ...outRows.map(serializeCsvRow)];
  return {
    header: serializeCsvRow(header),
    body: lines.join('\n') + '\n',
    recordCount: outRows.length,
  };
}

export async function listInstanceCsvPaths(outputRoot, instanceIds) {
  const paths = [];
  for (const id of instanceIds) {
    paths.push(path.join(outputRoot, id, 'cci-agents.csv'));
  }
  return paths;
}

export default { mergeCsvFiles, listInstanceCsvPaths };
