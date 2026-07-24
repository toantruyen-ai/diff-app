function extractManager(str) {
  if (!str || typeof str !== 'string') return null;
  const m1 = str.match(/conflict with (?:manager )?["'`]?([^"'`\s:]+)["'`]?/i);
  if (m1 && m1[1]) return m1[1];
  const m2 = str.match(/manager:\s*["'`]?([^"'`\s:]+)["'`]?/i);
  if (m2 && m2[1]) return m2[1];
  return null;
}

function extractField(str) {
  if (!str || typeof str !== 'string') return null;
  const m1 = str.match(/:\s*(\.[^\r\n]+)/);
  if (m1 && m1[1]) {
    let f = m1[1].trim();
    f = f.replace(/\s+manager:.*$/i, '').replace(/\s+conflict with.*$/i, '').trim();
    return f;
  }
  const m2 = str.match(/Conflict:\s*(\.[^\s\r\n]+)/i);
  if (m2 && m2[1]) return m2[1].trim();
  return null;
}

function parseSsaConflicts(errorBody) {
  if (!errorBody) return [];

  const conflicts = [];

  if (typeof errorBody === 'object' && errorBody !== null) {
    const causes = errorBody.details?.causes;
    if (Array.isArray(causes)) {
      for (const cause of causes) {
        if (cause.reason === 'Conflict' || cause.field || cause.message?.includes('conflict')) {
          const manager = extractManager(cause.message) || 'unknown';
          const field = cause.field || extractField(cause.message) || 'unknown';
          conflicts.push({
            field,
            manager,
            message: `Field ${field} is owned by manager "${manager}"`,
          });
        }
      }
      if (conflicts.length > 0) return conflicts;
    }
  }

  const message = typeof errorBody === 'string'
    ? errorBody
    : (errorBody?.message || JSON.stringify(errorBody));

  const items = message.split(/,\s*(?=conflict with|Conflict:)/gi);

  for (const item of items) {
    const manager = extractManager(item);
    const field = extractField(item);
    if (manager || field) {
      const f = field || 'unknown';
      const m = manager || 'unknown';
      conflicts.push({
        field: f,
        manager: m,
        message: `Field ${f} is owned by manager "${m}"`,
      });
    }
  }

  if (conflicts.length === 0) {
    conflicts.push({
      field: 'unknown',
      manager: 'unknown',
      message: message || 'Apply conflict detected',
    });
  }

  return conflicts;
}

module.exports = {
  parseSsaConflicts,
};
