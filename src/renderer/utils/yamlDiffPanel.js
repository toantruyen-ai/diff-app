function buildDiffTree(diffOps) {
  if (!Array.isArray(diffOps)) return { name: 'root', children: [], rollup: { user: 0, server: 0, add: 0, remove: 0, change: 0 } };

  const root = {
    name: 'root',
    children: new Map(),
    ops: [],
    rollup: { user: 0, server: 0, add: 0, remove: 0, change: 0 },
  };

  for (const op of diffOps) {
    let curr = root;
    const path = op.path || [];

    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      if (!curr.children.has(seg)) {
        curr.children.set(seg, {
          name: seg,
          path: path.slice(0, i + 1),
          children: new Map(),
          ops: [],
          rollup: { user: 0, server: 0, add: 0, remove: 0, change: 0 },
        });
      }
      curr = curr.children.get(seg);

      if (op.source === 'user') curr.rollup.user++;
      if (op.source === 'server') curr.rollup.server++;
      if (op.kind === 'add') curr.rollup.add++;
      if (op.kind === 'remove') curr.rollup.remove++;
      if (op.kind === 'change') curr.rollup.change++;
    }
    curr.ops.push(op);
  }

  function convertMapToArray(node) {
    const childrenArr = Array.from(node.children.values()).map(convertMapToArray);
    return {
      name: node.name,
      path: node.path,
      rollup: node.rollup,
      ops: node.ops,
      children: childrenArr,
    };
  }

  return convertMapToArray(root);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDiffTreeHtml(node, filterSource = 'all') {
  if (!node) return '';

  let html = '<ul class="diff-tree-list">';

  const children = node.children || [];
  for (const child of children) {
    if (filterSource === 'user' && child.rollup.user === 0) continue;
    if (filterSource === 'server' && child.rollup.server === 0) continue;

    const isLeaf = child.children.length === 0;
    const hasUser = child.rollup.user > 0;
    const dotClass = hasUser ? 'diff-dot-user' : 'diff-dot-server';

    html += `<li class="diff-tree-item" data-path="${escapeHtml(JSON.stringify(child.path || []))}">`;
    html += `<div class="diff-tree-node-content">`;
    html += `<span class="diff-dot ${dotClass}" title="${hasUser ? 'User defined' : 'Server injected'}"></span>`;
    html += `<span class="diff-node-name">${escapeHtml(child.name)}</span>`;

    if (!isLeaf) {
      html += `<span class="diff-rollup-pill">${child.rollup.user} user / ${child.rollup.server} server</span>`;
    }

    for (const op of child.ops) {
      let badge = '';
      if (op.kind === 'add') badge = `<span class="diff-badge diff-badge-add">＋ ${escapeHtml(JSON.stringify(op.after))}</span>`;
      if (op.kind === 'remove') badge = `<span class="diff-badge diff-badge-remove">－ ${escapeHtml(JSON.stringify(op.before))}</span>`;
      if (op.kind === 'change') badge = `<span class="diff-badge diff-badge-change">～ ${escapeHtml(JSON.stringify(op.before))} → ${escapeHtml(JSON.stringify(op.after))}</span>`;
      html += badge;
    }

    html += `</div>`;

    if (!isLeaf) {
      html += renderDiffTreeHtml(child, filterSource);
    }

    html += `</li>`;
  }

  html += '</ul>';
  return html;
}

function renderConflictBarHtml(conflicts) {
  if (!Array.isArray(conflicts) || conflicts.length === 0) return '';

  const hasClientSideApply = conflicts.some((c) => c.manager === 'kubectl-client-side-apply' || c.manager === 'kubectl');

  let html = '<div class="diff-conflict-alert">';
  html += '<strong>⚠️ Field-Ownership Conflict (409):</strong>';
  html += '<ul>';

  for (const c of conflicts) {
    const field = escapeHtml(c.field || 'Field');
    const manager = escapeHtml(c.manager || 'external-controller');
    html += `<li>Field <code>${field}</code> is currently owned by manager <code>"${manager}"</code>.</li>`;
  }

  html += '</ul>';

  if (hasClientSideApply) {
    html += '<p class="diff-conflict-note" style="margin: 4px 0; font-size: 12px; opacity: 0.9;">💡 Resource này trước đó được áp dụng bằng <code>kubectl apply</code> (Client-Side Apply). Bạn có thể bấm <strong>Force Overwrite (force=true)</strong> để an toàn chuyển quyền quản lý sang Server-Side Apply.</p>';
  }

  html += '<div class="diff-conflict-actions">';
  html += '<button id="manage-yaml-force-apply" class="btn btn-xs btn-warning">Force Overwrite (force=true)</button>';
  html += '</div>';
  html += '</div>';

  return html;
}

module.exports = {
  buildDiffTree,
  renderDiffTreeHtml,
  renderConflictBarHtml,
};
