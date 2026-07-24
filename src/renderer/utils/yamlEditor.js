const { buildDiffTree, renderDiffTreeHtml, renderConflictBarHtml } = require('./yamlDiffPanel');

function initYamlEditor(containerEl, api) {
  let activeRef = null;
  let activeContext = null;
  let currentDocYaml = '';

  const dryRunBtn = containerEl.querySelector('#manage-yaml-dryrun');
  const applyBtn = containerEl.querySelector('#manage-yaml-save');
  const textarea = containerEl.querySelector('#manage-yaml-textarea');
  const diffPane = containerEl.querySelector('#manage-yaml-diff-panel');
  const conflictBar = containerEl.querySelector('#manage-yaml-conflict-bar');
  const lintBadge = containerEl.querySelector('#manage-yaml-lint-badge');

  let lintTimeout = null;

  function setContext(ref, context) {
    activeRef = ref;
    activeContext = context;
  }

  function handleKeystroke() {
    if (lintTimeout) clearTimeout(lintTimeout);
    lintTimeout = setTimeout(async () => {
      const text = textarea ? textarea.value : '';
      if (!text || !api.lintYaml) return;
      const res = await api.lintYaml(text);
      if (lintBadge) {
        if (!res.ok) {
          lintBadge.className = 'badge badge-error';
          lintBadge.textContent = `${res.level || 'L0'}: ${res.error}`;
        } else if (res.issues && res.issues.length > 0) {
          lintBadge.className = 'badge badge-warning';
          lintBadge.textContent = `Lint: ${res.issues.length} warnings`;
        } else {
          lintBadge.className = 'badge badge-success';
          lintBadge.textContent = 'Valid (L0-L2)';
        }
      }
    }, 300);
  }

  async function runDryRun() {
    const yamlText = textarea ? textarea.value : '';
    if (!yamlText || !activeRef || !api.dryRunYaml) return { ok: false, error: 'Missing input' };

    const isMultiDoc = yamlText.includes('---');
    let res;
    if (isMultiDoc && api.dryRunBatchYaml) {
      res = await api.dryRunBatchYaml(activeRef, activeContext, yamlText);
    } else {
      res = await api.dryRunYaml(activeRef, activeContext, yamlText);
    }

    if (diffPane) {
      diffPane.style.display = 'block';
      if (res.ok) {
        const diffs = isMultiDoc
          ? (res.results || []).flatMap((r) => r.result?.diffs || [])
          : (res.diffs || []);
        const tree = buildDiffTree(diffs);
        diffPane.innerHTML = `
          <div class="diff-tree-header">
            <strong>Structured Diff (${diffs.length} changes)</strong>
            <span class="diff-filter-group">
              <button class="btn btn-xs btn-ghost filter-all active">All</button>
              <button class="btn btn-xs btn-ghost filter-user">User</button>
              <button class="btn btn-xs btn-ghost filter-server">Server</button>
            </span>
          </div>
          <div class="diff-tree-body">${renderDiffTreeHtml(tree, 'all')}</div>
        `;

        bindDiffEvents(diffPane, yamlText);
      } else if (res.kind === 'conflict' || (res.conflicts && res.conflicts.length > 0)) {
        if (conflictBar && typeof renderConflictBarHtml === 'function') {
          conflictBar.innerHTML = renderConflictBarHtml(res.conflicts || []);
          conflictBar.style.display = 'block';
        }
        const esc = (s) => (s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '');
        const itemsHtml = (res.conflicts || [])
          .map((c) => `<li>Field <code>${esc(c.field)}</code> is owned by manager <code>"${esc(c.manager)}"</code></li>`)
          .join('');
        const hasClientSide = (res.conflicts || []).some((c) => c.manager === 'kubectl-client-side-apply' || c.manager === 'kubectl');
        const hintText = hasClientSide
          ? '💡 Resource này trước đó được tạo/sửa bằng <code>kubectl apply</code> (Client-Side Apply). Việc chọn <strong>Force Overwrite (force=true)</strong> khi Apply là an toàn để nhận quyền quản lý sang Server-Side Apply.'
          : 'These fields are owned by other field managers (e.g. HPA, Helm, kubectl). Remove conflicting fields or use Force Overwrite to take ownership.';
        diffPane.innerHTML = `
          <div class="diff-error diff-conflict-box">
            <strong>⚠️ Apply Conflict Detected (409)</strong>
            <p>Field-ownership conflict detected during Server-Side Apply:</p>
            <ul>${itemsHtml}</ul>
            <div class="diff-conflict-hint">${hintText}</div>
          </div>
        `;
      } else {
        const esc = (s) => (s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '');
        diffPane.innerHTML = `<div class="diff-error">Dry-run error: ${esc(res.error || 'Failed')}</div>`;
      }
    }

    return res;
  }

  function bindDiffEvents(paneEl, yamlText) {
    if (!paneEl || typeof paneEl.querySelectorAll !== 'function') return;
    paneEl.querySelectorAll('.diff-tree-item').forEach((item) => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const rawPath = item.getAttribute('data-path');
        if (!rawPath) return;
        try {
          const path = JSON.parse(rawPath);
          if (api.mapYamlPos) {
            const posRes = await api.mapYamlPos(yamlText, path);
            if (posRes.ok && posRes.pos && textarea) {
              const lines = yamlText.split('\n');
              let charCount = 0;
              for (let i = 0; i < posRes.pos.line - 1; i++) {
                charCount += lines[i].length + 1;
              }
              textarea.focus();
              textarea.setSelectionRange(charCount, charCount);
            }
          }
        } catch {
          // invalid path
        }
      });
    });
  }

  async function performApply(force = false) {
    const yamlText = textarea ? textarea.value : '';
    if (!yamlText || !activeRef || !api.applySsaYaml) return { ok: false, error: 'Missing input' };

    const forceBtn = conflictBar && typeof conflictBar.querySelector === 'function'
      ? conflictBar.querySelector('#manage-yaml-force-apply')
      : null;
    const origForceText = forceBtn ? forceBtn.textContent : '';
    if (forceBtn) {
      forceBtn.disabled = true;
      forceBtn.textContent = 'Applying (force=true)…';
    }
    if (applyBtn) applyBtn.disabled = true;

    try {
      const isMultiDoc = yamlText.includes('---');
      let res;
      if (isMultiDoc && api.applyBatchYaml) {
        res = await api.applyBatchYaml(activeRef, activeContext, yamlText, force);
      } else {
        res = await api.applySsaYaml(activeRef, activeContext, yamlText, force);
      }

      if (res.ok) {
        if (conflictBar) conflictBar.style.display = 'none';
        if (diffPane) {
          diffPane.style.display = 'block';
          diffPane.innerHTML = `
            <div class="diff-success" style="padding:12px;background:rgba(46,160,67,0.15);border:1px solid #2ea043;border-radius:6px;color:#3fb950;margin-top:8px;">
              <strong>✓ Applied Successfully</strong>
              <p style="margin:4px 0 0 0;font-size:12px;">Server-Side Apply ${force ? '(with force=true) ' : ''}succeeded.</p>
            </div>
          `;
        }
      } else if (res.kind === 'conflict' || (res.conflicts && res.conflicts.length > 0)) {
        if (conflictBar && typeof renderConflictBarHtml === 'function') {
          conflictBar.style.display = 'block';
          conflictBar.innerHTML = renderConflictBarHtml(res.conflicts || []);
          const newForceBtn = conflictBar.querySelector('#manage-yaml-force-apply');
          if (newForceBtn) {
            newForceBtn.addEventListener('click', () => performApply(true));
          }
        }
        const esc = (s) => (s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '');
        const itemsHtml = (res.conflicts || [])
          .map((c) => `<li>Field <code>${esc(c.field)}</code> is owned by manager <code>"${esc(c.manager)}"</code></li>`)
          .join('');
        const hasClientSide = (res.conflicts || []).some((c) => c.manager === 'kubectl-client-side-apply' || c.manager === 'kubectl');
        const hintText = hasClientSide
          ? '💡 Resource này trước đó được tạo/sửa bằng <code>kubectl apply</code> (Client-Side Apply). Việc chọn <strong>Force Overwrite (force=true)</strong> khi Apply là an toàn để nhận quyền quản lý sang Server-Side Apply.'
          : 'These fields are owned by other field managers (e.g. HPA, Helm, kubectl). Remove conflicting fields or use Force Overwrite to take ownership.';
        if (diffPane) {
          diffPane.style.display = 'block';
          diffPane.innerHTML = `
            <div class="diff-error diff-conflict-box">
              <strong>⚠️ Apply Conflict Detected (409)</strong>
              <p>Field-ownership conflict detected during Server-Side Apply:</p>
              <ul>${itemsHtml}</ul>
              <div class="diff-conflict-hint">${hintText}</div>
            </div>
          `;
        }
      } else {
        if (conflictBar) conflictBar.style.display = 'none';
        if (diffPane) {
          const esc = (s) => (s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '');
          diffPane.style.display = 'block';
          diffPane.innerHTML = `<div class="diff-error">Apply error: ${esc(res.error || 'Failed')}</div>`;
        }
      }

      return res;
    } finally {
      if (forceBtn) {
        forceBtn.disabled = false;
        forceBtn.textContent = origForceText;
      }
      if (applyBtn) applyBtn.disabled = false;
    }
  }

  if (textarea) {
    textarea.addEventListener('input', handleKeystroke);
  }
  if (dryRunBtn) {
    dryRunBtn.addEventListener('click', runDryRun);
  }
  if (applyBtn) {
    applyBtn.addEventListener('click', () => performApply(false));
  }
  if (conflictBar && typeof conflictBar.addEventListener === 'function') {
    conflictBar.addEventListener('click', (e) => {
      const forceBtn = e.target && e.target.closest ? e.target.closest('#manage-yaml-force-apply') : null;
      if (forceBtn) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        performApply(true);
      }
    });
  }

  return {
    setContext,
    runDryRun,
    performApply,
  };
}

module.exports = {
  initYamlEditor,
};
