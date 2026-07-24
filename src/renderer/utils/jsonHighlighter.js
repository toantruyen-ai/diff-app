const { escHtml } = require('./htmlUtils');

const JSON_TOKEN_RE = /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|(true|false)\b|(null)\b|([{}[\],])/g;

function highlightJsonLine(line) {
  if (!line) return '';
  JSON_TOKEN_RE.lastIndex = 0;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = JSON_TOKEN_RE.exec(line)) !== null) {
    const matchIndex = match.index;
    if (matchIndex > lastIndex) {
      result += escHtml(line.slice(lastIndex, matchIndex));
    }

    const [raw, strVal, , colon, numVal, boolVal, nullVal, punctVal] = match;

    if (strVal !== undefined) {
      if (colon !== undefined) {
        result += `<span class="json-key">${escHtml(strVal)}</span><span class="json-punct">:</span>`;
      } else {
        result += `<span class="json-string">${escHtml(strVal)}</span>`;
      }
    } else if (numVal !== undefined) {
      result += `<span class="json-number">${escHtml(numVal)}</span>`;
    } else if (boolVal !== undefined) {
      result += `<span class="json-bool">${escHtml(boolVal)}</span>`;
    } else if (nullVal !== undefined) {
      result += `<span class="json-null">${escHtml(nullVal)}</span>`;
    } else if (punctVal !== undefined) {
      result += `<span class="json-punct">${escHtml(punctVal)}</span>`;
    } else {
      result += escHtml(raw);
    }

    lastIndex = JSON_TOKEN_RE.lastIndex;
  }

  if (lastIndex < line.length) {
    result += escHtml(line.slice(lastIndex));
  }

  return result;
}

function highlightJson(text) {
  if (text == null) return '';
  return String(text).split('\n').map(highlightJsonLine).join('\n');
}

module.exports = {
  highlightJsonLine,
  highlightJson,
};
