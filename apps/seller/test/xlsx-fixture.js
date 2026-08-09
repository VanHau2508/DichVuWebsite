import { buildZip } from '../src/zip.js';

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function colName(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) { n--; out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}

export async function buildXlsx(rows, extraEntries = []) {
  const strings = [];
  const stringIndex = new Map();
  const shared = (value) => {
    const key = String(value);
    if (!stringIndex.has(key)) { stringIndex.set(key, strings.length); strings.push(key); }
    return stringIndex.get(key);
  };
  const rowXml = rows.map((row, ri) => {
    const cells = row.map((cell, ci) => {
      if (cell == null) return '';
      const spec = typeof cell === 'object' && !Array.isArray(cell) ? cell : { value: cell, type: 's' };
      const ref = `${colName(ci)}${ri + 1}`;
      if (spec.type === 'inlineStr') return `<c r="${ref}" t="inlineStr"><is><t>${esc(spec.value)}</t></is></c>`;
      if (spec.type === 'n') return `<c r="${ref}"><v>${esc(spec.value)}</v></c>`;
      return `<c r="${ref}" t="s"><v>${shared(spec.value)}</v></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  const workbook = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>';
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  const sharedXml = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  return buildZip([
    { name: 'xl/workbook.xml', data: Buffer.from(workbook) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedXml) },
    ...extraEntries,
  ]);
}
