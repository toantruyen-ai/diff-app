import { describe, it, expect } from 'vitest';
import { buildDiffTree, renderDiffTreeHtml, renderConflictBarHtml } from '../../../src/renderer/utils/yamlDiffPanel.js';

describe('yamlDiffPanel', () => {
  it('builds tree from structured diff operations with rollup counts', () => {
    const ops = [
      { path: ['spec', 'replicas'], kind: 'change', before: 1, after: 2, source: 'user' },
      { path: ['spec', 'template', 'spec', 'containers', '0', 'image'], kind: 'change', before: 'a', after: 'b', source: 'user' },
      { path: ['spec', 'template', 'spec', 'containers', '0', 'imagePullPolicy'], kind: 'add', after: 'Always', source: 'server' },
    ];

    const tree = buildDiffTree(ops);
    expect(tree.children.length).toBe(1); // 'spec'
    const specNode = tree.children[0];
    expect(specNode.name).toBe('spec');
    expect(specNode.rollup.user).toBe(2);
    expect(specNode.rollup.server).toBe(1);
  });

  it('renders diff tree HTML with source dots and badges', () => {
    const ops = [
      { path: ['spec', 'replicas'], kind: 'change', before: 1, after: 2, source: 'user' },
    ];
    const tree = buildDiffTree(ops);
    const html = renderDiffTreeHtml(tree, 'all');

    expect(html).toContain('diff-dot-user');
    expect(html).toContain('diff-badge-change');
    expect(html).toContain('spec');
    expect(html).toContain('replicas');
  });

  it('renders conflict alert bar HTML with field ownership details', () => {
    const conflicts = [
      { field: '.spec.replicas', manager: 'hpa-controller' },
    ];
    const html = renderConflictBarHtml(conflicts);

    expect(html).toContain('.spec.replicas');
    expect(html).toContain('hpa-controller');
    expect(html).toContain('manage-yaml-force-apply');
  });
});
