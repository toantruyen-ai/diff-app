import { describe, it, expect } from 'vitest';
const {
  redactText,
  isSensitiveKey,
  redactEnvVars,
  redactContext,
  REDACTED_MARKER,
} = require('../../../../src/main/services/troubleshootingRedactorService');

describe('troubleshootingRedactorService', () => {
  it('redacts tokens, auth headers, and connection strings in raw text', () => {
    const raw = 'Authorization: Bearer mySecretToken123\nConnecting to postgres://user:secretPass@localhost:5432/db';
    const redacted = redactText(raw);
    expect(redacted).not.toContain('mySecretToken123');
    expect(redacted).not.toContain('secretPass');
    expect(redacted).toContain(REDACTED_MARKER);
    expect(redacted).toContain('postgres://user:***REDACTED***@localhost:5432/db');
  });

  it('identifies sensitive keys correctly', () => {
    expect(isSensitiveKey('DB_PASSWORD')).toBe(true);
    expect(isSensitiveKey('API_KEY')).toBe(true);
    expect(isSensitiveKey('APP_NAME')).toBe(false);
  });

  it('redacts environment variables with sensitive keys', () => {
    const env = [
      { name: 'DB_PASSWORD', value: 'super-secret' },
      { name: 'PORT', value: '8080' },
    ];
    const redacted = redactEnvVars(env);
    expect(redacted[0].value).toBe(REDACTED_MARKER);
    expect(redacted[1].value).toBe('8080');
  });

  it('redacts full analysis context', () => {
    const ctx = {
      containers: [
        {
          name: 'app',
          env: [{ name: 'AUTH_TOKEN', value: 'abc123secret' }],
        },
      ],
      logsPrevious: 'Authorization: Bearer secretLogData',
      logsCurrent: 'Started server',
      events: [{ message: 'Failed password auth for user' }],
    };

    const redacted = redactContext(ctx);
    expect(redacted.containers[0].env[0].value).toBe(REDACTED_MARKER);
    expect(redacted.logsPrevious).not.toContain('secretLogData');
    expect(redacted.logsPrevious).toContain(REDACTED_MARKER);
  });
});
