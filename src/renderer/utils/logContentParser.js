/**
 * Log content parser for auto-detecting JSON, logfmt (key=value), or text.
 */

const LOGFMT_RE = /([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|\S+)/g;

function findBalancedJsonSpan(message) {
  let startIndex = -1;
  for (let i = 0; i < message.length; i++) {
    const c = message[i];
    if (c === '{' || c === '[') {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) return null;

  let inString = false;
  let escape = false;
  const stack = [];

  for (let i = startIndex; i < message.length; i++) {
    const c = message[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === '{' || c === '[') {
      stack.push(c);
      continue;
    }

    if (c === '}') {
      if (stack.length === 0 || stack[stack.length - 1] !== '{') return null;
      stack.pop();
      if (stack.length === 0) {
        return { startIndex, endIndex: i };
      }
    } else if (c === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== '[') return null;
      stack.pop();
      if (stack.length === 0) {
        return { startIndex, endIndex: i };
      }
    }
  }

  return null;
}

function parseLogContent(message) {
  if (!message || typeof message !== 'string') {
    return { type: 'text', value: String(message || '') };
  }

  // Cap length to prevent performance issues on massive lines
  if (message.length > 20000) {
    return { type: 'text', value: message };
  }

  // 1. Try JSON parsing
  const jsonSpan = findBalancedJsonSpan(message);
  if (jsonSpan) {
    const candidate = message.slice(jsonSpan.startIndex, jsonSpan.endIndex + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object') {
        return {
          type: 'json',
          prefix: message.slice(0, jsonSpan.startIndex),
          suffix: message.slice(jsonSpan.endIndex + 1),
          value: JSON.stringify(parsed, null, 2),
        };
      }
    } catch {
      // Not valid JSON, fall through to logfmt / text
    }
  }

  // 2. Try logfmt / key=value parsing
  LOGFMT_RE.lastIndex = 0;
  const matches = [];
  let match;
  let matchedCharsLength = 0;

  while ((match = LOGFMT_RE.exec(message)) !== null) {
    matches.push(match);
    matchedCharsLength += match[0].length;
  }

  const trimmedLength = message.trim().length;
  if (matches.length >= 2 && (matchedCharsLength / (trimmedLength || 1)) >= 0.6) {
    const pairs = matches.map((m) => {
      const key = m[1];
      let val = m[2];
      if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
        val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      return [key, val];
    });

    return {
      type: 'kv',
      pairs,
    };
  }

  // 3. Fallback to text
  return {
    type: 'text',
    value: message,
  };
}

module.exports = {
  parseLogContent,
};
