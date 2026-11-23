// Minimal RFC 4180 helpers. A cell is quoted only when it needs to be (comma,
// quote or line break), with embedded quotes doubled.
//
// Spreadsheet applications can evaluate cells even when they are quoted.
// Prefix formula-like text with an apostrophe. The snapshot API still returns
// the original code and output verbatim.

const quoteCell = (text) => `"${text.replace(/"/g, '""')}"`;

export const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (typeof value === 'string' && (/^[\t\r\n]/.test(text) || /^[=+@-]/.test(text.trimStart()))) {
    return quoteCell("'" + text);
  }
  return /[",\r\n]/.test(text) ? quoteCell(text) : text;
};

export const csvRow = (cells) => `${cells.map(csvCell).join(',')}\n`;
