function mapPathToPosition(yamlText, path) {
  if (!yamlText || typeof yamlText !== 'string' || !Array.isArray(path) || path.length === 0) {
    return null;
  }

  const lines = yamlText.split(/\r?\n/);

  // Filter out list item selectors like 'name=app' or '~foo'
  const pathKeys = path
    .map((seg) => {
      let s = String(seg);
      if (s.startsWith('~')) s = s.slice(1);
      if (s.includes('=')) s = s.split('=')[0];
      return s;
    })
    .filter((s) => !/^\d+$/.test(s));

  if (pathKeys.length === 0) return null;

  let currentKeyIdx = 0;
  let targetKey = pathKeys[pathKeys.length - 1];

  let matchedLine = null;
  let matchedCol = 1;
  let minIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed) continue;

    const indent = line.search(/\S/);

    // Check if line defines current path segment
    const searchKey = pathKeys[currentKeyIdx];
    const keyRegex = new RegExp(`^(\\s*)(?:-\\s*)?(${searchKey}):`);
    const m = line.match(keyRegex);

    if (m && indent > minIndent) {
      if (currentKeyIdx === pathKeys.length - 1) {
        matchedLine = i + 1;
        matchedCol = (indent >= 0 ? indent : 0) + 1;
        break;
      } else {
        currentKeyIdx++;
        minIndent = indent;
      }
    }
  }

  // Fallback to simple line match if hierarchy traversal did not match
  if (matchedLine === null) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const indent = line.search(/\S/);
      if (line.includes(`${targetKey}:`)) {
        return { line: i + 1, column: (indent >= 0 ? indent : 0) + 1 };
      }
    }
  }

  if (matchedLine !== null) {
    return { line: matchedLine, column: matchedCol };
  }

  return null;
}

module.exports = {
  mapPathToPosition,
};
