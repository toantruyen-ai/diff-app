/**
 * Escapes HTML characters in string.
 * @param {string} str 
 * @returns {string}
 */
function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Escapes a single CSV value.
 * @param {any} val 
 * @returns {string}
 */
function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Converts array of rows to CSV string.
 * @param {Array<string>} headers 
 * @param {Array<Array<any>>} rows 
 * @returns {string}
 */
function rowsToCsv(headers, rows) {
  const line1 = headers.map(csvEscape).join(',');
  const rest = rows.map((r) => r.map(csvEscape).join(','));
  return [line1, ...rest].join('\r\n');
}

/**
 * Triggers a browser file download.
 * @param {string} filename 
 * @param {string} content 
 * @param {string} mime 
 */
function downloadTextFile(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

module.exports = {
  escHtml,
  csvEscape,
  rowsToCsv,
  downloadTextFile,
};
