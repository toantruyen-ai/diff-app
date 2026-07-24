/**
 * Utility functions for parsing K8s log lines with RFC3339 timestamps and log levels.
 */

// RFC3339 / ISO8601 timestamp regex at start of line
const RFC3339_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s?(.*)$/;

// Common log level regex
const LEVEL_REGEX = /(?:FATAL|ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE)/i;

function parseLogLine(rawLine) {
  if (!rawLine) {
    return { ts: Date.now(), message: '', level: 'INFO' };
  }

  let ts = Date.now();
  let message = rawLine;
  const match = rawLine.match(RFC3339_REGEX);

  if (match) {
    const parsedTs = Date.parse(match[1]);
    if (!isNaN(parsedTs)) {
      ts = parsedTs;
    }
    message = match[2];
  }

  let level = 'INFO';
  const levelMatch = message.match(LEVEL_REGEX);
  if (levelMatch) {
    const lvl = levelMatch[0].toUpperCase();
    if (lvl === 'ERR') level = 'ERROR';
    else if (lvl === 'WARNING') level = 'WARN';
    else level = lvl;
  }

  return { ts, message, level };
}

function detectLogLevel(message) {
  if (!message) return 'INFO';
  const levelMatch = message.match(LEVEL_REGEX);
  if (!levelMatch) return 'INFO';
  const lvl = levelMatch[0].toUpperCase();
  if (lvl === 'ERR') return 'ERROR';
  if (lvl === 'WARNING') return 'WARN';
  return lvl;
}

function computeLineFingerprint(ts, message) {
  // Simple fast string fingerprint for deduplication
  return `${ts}:${message.slice(0, 120)}`;
}

function splitLines(chunk, leftover = '') {
  const text = leftover + chunk;
  const parts = text.split('\n');
  const newLeftover = parts.pop() || '';
  return { lines: parts, leftover: newLeftover };
}

module.exports = {
  parseLogLine,
  detectLogLevel,
  computeLineFingerprint,
  splitLines,
};

