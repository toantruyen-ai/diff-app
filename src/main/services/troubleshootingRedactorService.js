const REDACTED_MARKER = '***REDACTED***';

const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|api_?key|auth|credential|jwt|private_?key|access_?key|bearer)/i;
const JWT_PATTERN = /eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g;
const AUTH_HEADER_PATTERN = /(Authorization:\s*)([^\s]+(?:\s+[^\s]+)?)/gi;
const CONN_STRING_PATTERN = /([a-z0-9+.-]+:\/\/[^:]+:)([^@]+)(@.+)/gi;
const GENERAL_TOKEN_PATTERN = /\b(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|xox[baprs]-[a-zA-Z0-9-]{10,})\b/g;

function redactText(text) {
  if (typeof text !== 'string') return text;
  let result = text;
  result = result.replace(AUTH_HEADER_PATTERN, `$1${REDACTED_MARKER}`);
  result = result.replace(CONN_STRING_PATTERN, `$1${REDACTED_MARKER}$3`);
  result = result.replace(JWT_PATTERN, REDACTED_MARKER);
  result = result.replace(GENERAL_TOKEN_PATTERN, REDACTED_MARKER);
  return result;
}

function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  return SENSITIVE_KEY_PATTERN.test(key);
}

function redactEnvVars(envVars) {
  if (!Array.isArray(envVars)) return [];
  return envVars.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const name = item.name || item.key || '';
    const value = item.value;
    if (isSensitiveKey(name) || (value && typeof value === 'string' && (SENSITIVE_KEY_PATTERN.test(value) || value.length > 100))) {
      return { ...item, value: REDACTED_MARKER };
    }
    return { ...item, value: redactText(value) };
  });
}

function redactContext(context) {
  if (!context || typeof context !== 'object') return context;
  const cloned = JSON.parse(JSON.stringify(context));

  if (cloned.containers && Array.isArray(cloned.containers)) {
    cloned.containers = cloned.containers.map((c) => ({
      ...c,
      env: redactEnvVars(c.env),
    }));
  }

  if (cloned.logsPrevious) cloned.logsPrevious = redactText(cloned.logsPrevious);
  if (cloned.logsCurrent) cloned.logsCurrent = redactText(cloned.logsCurrent);

  if (cloned.events && Array.isArray(cloned.events)) {
    cloned.events = cloned.events.map((e) => ({
      ...e,
      message: redactText(e.message),
    }));
  }

  return cloned;
}

module.exports = {
  REDACTED_MARKER,
  redactText,
  isSensitiveKey,
  redactEnvVars,
  redactContext,
};
