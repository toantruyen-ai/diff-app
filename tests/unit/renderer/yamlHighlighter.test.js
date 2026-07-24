import { describe, it, expect } from 'vitest';
import { highlightYaml, highlightYamlLine } from '../../../src/renderer/utils/yamlHighlighter.js';

describe('yamlHighlighter', () => {
  it('highlights YAML comments', () => {
    const html = highlightYaml('# This is a comment');
    expect(html).toContain('<span class="yaml-comment"># This is a comment</span>');
  });

  it('highlights key-value pairs', () => {
    const html = highlightYaml('name: test-app');
    expect(html).toContain('<span class="yaml-key">name</span>');
    expect(html).toContain('<span class="yaml-string">test-app</span>');
  });

  it('highlights numbers and booleans', () => {
    const html = highlightYaml('replicas: 3\nenabled: true');
    expect(html).toContain('<span class="yaml-number">3</span>');
    expect(html).toContain('<span class="yaml-bool">true</span>');
  });
});
