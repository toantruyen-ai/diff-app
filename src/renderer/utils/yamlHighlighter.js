const { escHtml } = require('./htmlUtils');

const YAML_BOOL_NULL_RE = /^(true|false|yes|no|on|off|null|~)$/i;
const YAML_NUMBER_RE = /^[-+]?(0x[0-9a-fA-F]+|0o[0-7]+|(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?|\.inf|\.nan)$/i;
const YAML_BLOCK_SCALAR_RE = /^[|>][+-]?\d*$/;
const YAML_KEY_RE = /^(-\s+)?((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#\s][^:]*?)):([ \t][\s\S]*)?$/;
const YAML_LIST_SCALAR_RE = /^(-\s+)([\s\S]*)$/;

function findYamlCommentStart(s) {
  let inSingle = false, inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) { if (c === '\\') { i++; } else if (c === '"') inDouble = false; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return i;
  }
  return -1;
}

function tokenizeYamlScalar(text) {
  const [, lead, core, trail] = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (core === '') return escHtml(text);
  let cls = 'yaml-string';
  if (YAML_BOOL_NULL_RE.test(core)) cls = 'yaml-bool';
  else if (YAML_NUMBER_RE.test(core)) cls = 'yaml-number';
  else if (YAML_BLOCK_SCALAR_RE.test(core)) cls = 'yaml-punct';
  return `${escHtml(lead)}<span class="${cls}">${escHtml(core)}</span>${escHtml(trail)}`;
}

function renderYamlIndentGuides(indent) {
  const unit = 2;
  let html = '';
  let i = 0;
  for (; i + unit <= indent.length; i += unit) {
    html += `<span class="yaml-indent-guide">${escHtml(indent.slice(i, i + unit))}</span>`;
  }
  if (i < indent.length) html += escHtml(indent.slice(i));
  return html;
}

function highlightYamlLine(line) {
  const [, indent, rest] = line.match(/^(\s*)([\s\S]*)$/);
  if (rest === '') return escHtml(indent);
  const indentHtml = renderYamlIndentGuides(indent);
  const trimmedRest = rest.trim();
  if (trimmedRest === '---' || trimmedRest === '...') {
    return `${indentHtml}<span class="yaml-docsep">${escHtml(trimmedRest)}</span>`;
  }
  if (rest[0] === '#') {
    return `${indentHtml}<span class="yaml-comment">${escHtml(rest)}</span>`;
  }

  const commentIdx = findYamlCommentStart(rest);
  const valuePart = commentIdx === -1 ? rest : rest.slice(0, commentIdx);
  const commentPart = commentIdx === -1 ? '' : rest.slice(commentIdx);

  let bodyHtml;
  const keyMatch = valuePart.match(YAML_KEY_RE);
  if (keyMatch) {
    const dash = keyMatch[1] || '';
    const key = keyMatch[2];
    const tail = keyMatch[3];
    bodyHtml = (dash ? `<span class="yaml-dash">${escHtml(dash)}</span>` : '')
      + `<span class="yaml-key">${escHtml(key)}</span><span class="yaml-punct">:</span>`
      + (tail ? tokenizeYamlScalar(tail) : '');
  } else {
    const listMatch = valuePart.match(YAML_LIST_SCALAR_RE);
    if (listMatch) {
      bodyHtml = `<span class="yaml-dash">${escHtml(listMatch[1])}</span>${tokenizeYamlScalar(listMatch[2])}`;
    } else {
      bodyHtml = tokenizeYamlScalar(valuePart);
    }
  }

  const commentHtml = commentPart ? `<span class="yaml-comment">${escHtml(commentPart)}</span>` : '';
  return indentHtml + bodyHtml + commentHtml;
}

function highlightYaml(text) {
  if (text == null) return '';
  const str = String(text);
  const html = str.split('\n').map(highlightYamlLine).join('\n');
  return str.endsWith('\n') ? html + '\n' : html;
}

module.exports = {
  findYamlCommentStart,
  tokenizeYamlScalar,
  renderYamlIndentGuides,
  highlightYamlLine,
  highlightYaml,
};
