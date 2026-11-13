// Minimal RFC 4180 helpers. A cell is quoted only when it needs to be (comma,
// quote or line break), with embedded quotes doubled.
//
// No spreadsheet-formula neutralisation is applied: prefixing cells that start
// with = + - @ would corrupt exported source code (e.g. a Python decorator).

export const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const csvRow = (cells) => `${cells.map(csvCell).join(',')}\n`;
