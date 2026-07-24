import { describe, it, expect } from 'vitest';
import { escHtml, csvEscape, rowsToCsv } from '../../../src/renderer/utils/htmlUtils.js';

describe('htmlUtils', () => {
  it('escHtml escapes special characters', () => {
    expect(escHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escHtml(null)).toBe('');
  });

  it('csvEscape handles quotes and commas', () => {
    expect(csvEscape('hello, world')).toBe('"hello, world"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it('rowsToCsv generates CSV format with carriage returns', () => {
    const csv = rowsToCsv(['Name', 'Value'], [['key1', 'val1'], ['key2', 'val2']]);
    expect(csv).toBe('Name,Value\r\nkey1,val1\r\nkey2,val2');
  });
});
