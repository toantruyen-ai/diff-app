import { describe, it, expect } from 'vitest';
import { parseLogContent } from '../../../src/renderer/utils/logContentParser.js';

describe('logContentParser', () => {
  it('parses pure JSON string correctly', () => {
    const res = parseLogContent('{"user":"admin","status":200}');
    expect(res.type).toBe('json');
    expect(res.prefix).toBe('');
    expect(res.suffix).toBe('');
    expect(res.value).toContain('"user": "admin"');
    expect(res.value).toContain('"status": 200');
  });

  it('parses JSON with timestamp and log level prefix', () => {
    const res = parseLogContent('2026-07-24T14:00:00Z INFO {"action":"login","ok":true}');
    expect(res.type).toBe('json');
    expect(res.prefix).toBe('2026-07-24T14:00:00Z INFO ');
    expect(res.value).toContain('"action": "login"');
  });

  it('falls back to text on truncated or malformed JSON without throwing', () => {
    const res = parseLogContent('2026-07-24T14:00:00Z INFO {"action":"login",');
    expect(res.type).toBe('text');
    expect(res.value).toBe('2026-07-24T14:00:00Z INFO {"action":"login",');
  });

  it('parses logfmt key-value formatted lines', () => {
    const res = parseLogContent('level=info ts=2026-07-24T14:00:00Z caller=main.go:42 msg="user login success" latency=12ms');
    expect(res.type).toBe('kv');
    expect(res.pairs).toEqual([
      ['level', 'info'],
      ['ts', '2026-07-24T14:00:00Z'],
      ['caller', 'main.go:42'],
      ['msg', 'user login success'],
      ['latency', '12ms'],
    ]);
  });

  it('treats false-positive single key=value sentence as text', () => {
    const res = parseLogContent("result = 42 and that's fine");
    expect(res.type).toBe('text');
    expect(res.value).toBe("result = 42 and that's fine");
  });

  it('handles empty or non-string inputs safely', () => {
    expect(parseLogContent('').type).toBe('text');
    expect(parseLogContent(null).type).toBe('text');
    expect(parseLogContent(undefined).type).toBe('text');
  });

  it('bypasses parsing for strings longer than 20000 chars', () => {
    const huge = 'a'.repeat(20001);
    const res = parseLogContent(huge);
    expect(res.type).toBe('text');
    expect(res.value).toBe(huge);
  });
});
