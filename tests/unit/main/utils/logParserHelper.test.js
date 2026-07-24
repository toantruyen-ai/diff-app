import { describe, it, expect } from 'vitest';
import { parseLogLine, detectLogLevel, computeLineFingerprint, splitLines } from '../../../../src/main/utils/logParserHelper.js';

describe('logParserHelper', () => {
  it('parses RFC3339 timestamp prefix', () => {
    const raw = '2026-07-24T11:26:41.123456789Z [INFO] Application started successfully';
    const result = parseLogLine(raw);
    expect(result.ts).toBe(Date.parse('2026-07-24T11:26:41.123456789Z'));
    expect(result.message).toBe('[INFO] Application started successfully');
    expect(result.level).toBe('INFO');
  });

  it('handles log line without timestamp prefix', () => {
    const raw = 'Simple message without timestamp';
    const result = parseLogLine(raw);
    expect(typeof result.ts).toBe('number');
    expect(result.message).toBe('Simple message without timestamp');
    expect(result.level).toBe('INFO');
  });

  it('detects ERROR and WARN levels correctly', () => {
    expect(detectLogLevel('Database connection failed: ERR_TIMEOUT')).toBe('ERROR');
    expect(detectLogLevel('High memory usage WARNING detected')).toBe('WARN');
    expect(detectLogLevel('Debug trace: variable x=5')).toBe('DEBUG');
  });

  it('computes line fingerprint for deduplication', () => {
    const fp1 = computeLineFingerprint(1700000000, 'log line content');
    const fp2 = computeLineFingerprint(1700000000, 'log line content');
    const fp3 = computeLineFingerprint(1700000001, 'log line content');
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
  });

  it('splits chunks cleanly with leftover lines', () => {
    const { lines: lines1, leftover: left1 } = splitLines('line1\nline2\npartial', '');
    expect(lines1).toEqual(['line1', 'line2']);
    expect(left1).toBe('partial');

    const { lines: lines2, leftover: left2 } = splitLines('End\nline3\n', left1);
    expect(lines2).toEqual(['partialEnd', 'line3']);
    expect(left2).toBe('');
  });
});

