import { describe, it, expect } from 'vitest';
import { highlightJson } from '../../../src/renderer/utils/jsonHighlighter.js';

describe('jsonHighlighter', () => {
  it('highlights JSON keys, strings, numbers, booleans, nulls, and punctuation', () => {
    const jsonText = JSON.stringify({
      name: 'Alice',
      age: 30,
      active: true,
      data: null,
    }, null, 2);

    const html = highlightJson(jsonText);
    expect(html).toContain('<span class="json-key">&quot;name&quot;</span>');
    expect(html).toContain('<span class="json-string">&quot;Alice&quot;</span>');
    expect(html).toContain('<span class="json-number">30</span>');
    expect(html).toContain('<span class="json-bool">true</span>');
    expect(html).toContain('<span class="json-null">null</span>');
    expect(html).toContain('<span class="json-punct">{</span>');
    expect(html).toContain('<span class="json-punct">}</span>');
  });

  it('escapes HTML special characters inside JSON keys and string values', () => {
    const jsonText = JSON.stringify({
      '<script>': 'alert("xss")',
    }, null, 2);

    const html = highlightJson(jsonText);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('alert(\\&quot;xss\\&quot;)');
  });

  it('handles nested objects and arrays cleanly', () => {
    const jsonText = JSON.stringify({
      items: [1, 'two', false],
    }, null, 2);

    const html = highlightJson(jsonText);
    expect(html).toContain('<span class="json-key">&quot;items&quot;</span>');
    expect(html).toContain('<span class="json-punct">[</span>');
    expect(html).toContain('<span class="json-number">1</span>');
    expect(html).toContain('<span class="json-string">&quot;two&quot;</span>');
    expect(html).toContain('<span class="json-bool">false</span>');
    expect(html).toContain('<span class="json-punct">]</span>');
  });

  it('returns empty string for null or undefined input', () => {
    expect(highlightJson(null)).toBe('');
    expect(highlightJson(undefined)).toBe('');
  });
});
