function escHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderAnalysisResult(containerEl, result) {
  if (!containerEl) return;
  if (!result) {
    containerEl.innerHTML = '<div class="manage-empty">No analysis result available.</div>';
    return;
  }

  const confidenceClass =
    result.confidence === 'high'
      ? 'badge-error'
      : result.confidence === 'medium'
      ? 'badge-warning'
      : 'badge-ghost';

  const degradedBadge = result.degraded
    ? '<span class="badge badge-warning" style="margin-left: 6px;">Rule-based fallback</span>'
    : '<span class="badge badge-success" style="margin-left: 6px;">AI Powered</span>';

  const evidenceHtml = (result.evidence || [])
    .map((e) => `<li style="font-family: monospace; font-size: 0.82rem; background: #161b22; padding: 4px 8px; border-radius: 4px; margin-bottom: 4px;">${escHtml(e)}</li>`)
    .join('');

  const fixStepsHtml = (result.fixSteps || [])
    .map((f) => `<li style="margin-bottom: 6px;">${escHtml(f)}</li>`)
    .join('');

  const commandsHtml = (result.commands || [])
    .map(
      (cmd, i) => `
    <div class="cmd-row" style="background: #0d1117; padding: 8px; border-radius: 4px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
      <code style="font-size: 0.85rem; color: #58a6ff; word-break: break-all;">${escHtml(cmd)}</code>
      <div style="display: flex; gap: 6px;">
        <button class="btn btn-xs btn-ghost copy-cmd-btn" data-cmd-index="${i}">Copy</button>
      </div>
    </div>`
    )
    .join('');

  const fallbackReasonHtml = result.degraded && result.fallbackReason
    ? `<div style="margin-bottom: 12px; padding: 8px 12px; background: rgba(234, 179, 8, 0.1); border: 1px solid rgba(234, 179, 8, 0.3); border-radius: 6px; color: #fde047; font-size: 0.82rem; line-height: 1.4;">
        <strong>⚠️ Rule-based Fallback Active:</strong> ${escHtml(result.fallbackReason)}
       </div>`
    : '';

  containerEl.innerHTML = `
    <div class="analysis-result-card" style="padding: 12px; background: #0f1117; border-radius: 6px; border: 1px solid #30363d; overflow-y: auto; max-height: 100%;">
      <div style="margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #21262d; padding-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span class="badge ${confidenceClass}">${escHtml((result.confidence || 'medium').toUpperCase())}</span>
          <span class="badge badge-outline">${escHtml(result.category || 'app')}</span>
          ${degradedBadge}
        </div>
      </div>

      ${fallbackReasonHtml}

      <div style="margin-bottom: 16px;">
        <h4 style="margin: 0 0 6px 0; font-size: 1rem; color: #f0f6fc;">Root Cause</h4>
        <p style="margin: 0; color: #c9d1d9; font-size: 0.9rem; line-height: 1.4;">${escHtml(result.rootCause || 'Unknown failure')}</p>
      </div>

      ${
        result.evidence && result.evidence.length > 0
          ? `<div style="margin-bottom: 16px;">
              <h5 style="margin: 0 0 6px 0; font-size: 0.85rem; color: #8b949e;">Evidence</h5>
              <ul style="margin: 0; padding-left: 0; list-style: none;">${evidenceHtml}</ul>
            </div>`
          : ''
      }

      ${
        result.fixSteps && result.fixSteps.length > 0
          ? `<div style="margin-bottom: 16px;">
              <h5 style="margin: 0 0 6px 0; font-size: 0.85rem; color: #8b949e;">Suggested Fixes</h5>
              <ul style="margin: 0; padding-left: 18px; color: #c9d1d9; font-size: 0.88rem;">${fixStepsHtml}</ul>
            </div>`
          : ''
      }

      ${
        result.commands && result.commands.length > 0
          ? `<div style="margin-bottom: 8px;">
              <h5 style="margin: 0 0 6px 0; font-size: 0.85rem; color: #8b949e;">Recommended Commands</h5>
              ${commandsHtml}
            </div>`
          : ''
      }

      ${
        result.logsPrevious
          ? `<details style="margin-top: 12px; background: #0d1117; padding: 8px 12px; border-radius: 6px; border: 1px solid #30363d;">
              <summary style="font-size: 0.83rem; color: #58a6ff; cursor: pointer; font-weight: bold; user-select: none;">
                📜 Ingested Crash Logs (--previous) & Diagnostic Status
              </summary>
              <pre style="margin-top: 8px; margin-bottom: 0; font-size: 0.78rem; color: #c9d1d9; font-family: monospace; white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow-y: auto; background: #161b22; padding: 8px; border-radius: 4px;">${escHtml(result.logsPrevious)}</pre>
            </details>`
          : ''
      }
    </div>
  `;

  containerEl.querySelectorAll('.run-cmd-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.cmdIndex, 10);
      const cmd = result.commands[idx];
      if (cmd && onRunCommand) {
        onRunCommand(cmd);
      } else if (cmd) {
        const ev = new CustomEvent('ai-run-command', { detail: { command: cmd }, bubbles: true });
        containerEl.dispatchEvent(ev);
      }
    });
  });

  containerEl.querySelectorAll('.copy-cmd-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.cmdIndex, 10);
      const cmd = result.commands[idx];
      if (cmd && navigator.clipboard) {
        navigator.clipboard.writeText(cmd);
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 2000);
      }
    });
  });
}

function renderAnalysisHistoryTable(containerEl, records, onDeleteRecord, onViewRecord) {
  if (!containerEl) return;
  if (!records || records.length === 0) {
    containerEl.innerHTML = '<div class="manage-empty" style="padding: 24px; text-align: center; color: #8b949e;">No AI analysis history recorded for this selection.</div>';
    return;
  }

  const rowsHtml = records
    .map((r, i) => {
      const confBadge =
        r.confidence === 'high'
          ? 'badge-error'
          : r.confidence === 'medium'
          ? 'badge-warning'
          : 'badge-ghost';
      const timeStr = r.timestamp ? new Date(r.timestamp).toLocaleString() : 'N/A';
      return `
      <tr style="border-bottom: 1px solid #21262d;">
        <td style="padding: 8px 12px; font-family: monospace; font-size: 0.85rem; color: #58a6ff;">${escHtml(r.podName)}</td>
        <td style="padding: 8px 12px; font-size: 0.85rem; color: #8b949e;">${escHtml(r.namespace)}</td>
        <td style="padding: 8px 12px; font-size: 0.82rem; color: #8b949e;">${escHtml(timeStr)}</td>
        <td style="padding: 8px 12px; font-size: 0.85rem; color: #c9d1d9; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escHtml(r.rootCause)}">${escHtml(r.rootCause)}</td>
        <td style="padding: 8px 12px;"><span class="badge ${confBadge}">${escHtml((r.confidence || 'medium').toUpperCase())}</span></td>
        <td style="padding: 8px 12px; text-align: right;">
          <button class="btn btn-xs btn-ghost view-history-btn" data-index="${i}">View</button>
          <button class="btn btn-xs btn-ghost btn-error delete-history-btn" data-id="${r.id}" style="margin-left: 4px;">Delete</button>
        </td>
      </tr>
    `;
    })
    .join('');

  containerEl.innerHTML = `
    <div class="sdr-table-wrap" style="background: #0f1117; border-radius: 6px; border: 1px solid #30363d;">
      <table class="sdr-table" style="width: 100%; border-collapse: collapse; text-align: left;">
        <thead>
          <tr style="border-bottom: 1px solid #30363d; background: #161b22; color: #8b949e; font-size: 0.8rem;">
            <th style="padding: 8px 12px;">Pod Name</th>
            <th style="padding: 8px 12px;">Namespace</th>
            <th style="padding: 8px 12px;">Timestamp</th>
            <th style="padding: 8px 12px;">Root Cause</th>
            <th style="padding: 8px 12px;">Confidence</th>
            <th style="padding: 8px 12px; text-align: right;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;

  containerEl.querySelectorAll('.delete-history-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.target.dataset.id;
      if (id && onDeleteRecord) onDeleteRecord(id);
    });
  });

  containerEl.querySelectorAll('.view-history-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      const record = records[idx];
      if (record && onViewRecord) onViewRecord(record);
    });
  });
}

module.exports = {
  renderAnalysisResult,
  renderAnalysisHistoryTable,
};
