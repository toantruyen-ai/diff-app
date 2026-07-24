const { escHtml } = require('./htmlUtils');
const { parseLogContent } = require('./logContentParser');
const { highlightJson } = require('./jsonHighlighter');

function createLogLineDetailModal(overlayEl) {
  let isOpen = false;
  let keyListener = null;

  function close() {
    if (!isOpen && (!overlayEl || overlayEl.style.display === 'none')) return;
    isOpen = false;
    if (overlayEl) {
      overlayEl.style.display = 'none';
    }
    if (typeof document !== 'undefined' && keyListener) {
      document.removeEventListener('keydown', keyListener, true);
      keyListener = null;
    }
  }

  function open(line) {
    close();
    if (!overlayEl || !line) return;

    const cardEl = overlayEl.querySelector('.mpl-detail-card') || overlayEl;
    const parsed = parseLogContent(line.message || '');
    let bodyHtml = '';
    let copyText = line.message || '';

    if (parsed.type === 'json') {
      copyText = (parsed.prefix || '') + parsed.value + (parsed.suffix || '');
      const prefixHtml = parsed.prefix ? `<div class="mpl-detail-prefix" style="color:var(--text-subtle,#8b949e);margin-bottom:8px;">${escHtml(parsed.prefix)}</div>` : '';
      const suffixHtml = parsed.suffix ? `<div class="mpl-detail-suffix" style="color:var(--text-subtle,#8b949e);margin-top:8px;">${escHtml(parsed.suffix)}</div>` : '';
      bodyHtml = `${prefixHtml}<pre class="mpl-detail-code">${highlightJson(parsed.value)}</pre>${suffixHtml}`;
    } else if (parsed.type === 'kv') {
      copyText = parsed.pairs.map(([k, v]) => `${k}=${v}`).join('\n');
      const rowsHtml = parsed.pairs.map(([k, v]) => `
        <tr>
          <td class="mpl-detail-kv-key">${escHtml(k)}</td>
          <td class="mpl-detail-kv-val">${escHtml(v)}</td>
        </tr>
      `).join('');
      bodyHtml = `<table class="mpl-detail-kv-table"><tbody>${rowsHtml}</tbody></table>`;
    } else {
      copyText = parsed.value;
      bodyHtml = `<pre class="mpl-detail-code">${escHtml(parsed.value)}</pre>`;
    }

    const podStr = escHtml(line.pod || 'unknown');
    const containerStr = escHtml(line.container || 'unknown');
    const tsStr = line.ts ? escHtml(new Date(line.ts).toISOString()) : '';

    cardEl.innerHTML = `
      <div class="mpl-detail-header">
        <div class="mpl-detail-title">Log Line Detail</div>
        <div class="mpl-detail-meta">
          <span class="mpl-detail-badge">${podStr} / ${containerStr}</span>
          ${tsStr ? `<span class="mpl-detail-ts">${tsStr}</span>` : ''}
        </div>
      </div>
      <div class="mpl-detail-body">${bodyHtml}</div>
      <div class="mpl-detail-actions">
        <button class="btn btn-secondary mpl-detail-copy-btn">Copy formatted</button>
        <button class="btn btn-primary mpl-detail-close-btn">Close</button>
      </div>
    `;

    const copyBtn = cardEl.querySelector('.mpl-detail-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(copyText).catch(() => {});
        }
        const origText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = origText; }, 1500);
      });
    }

    const closeBtn = cardEl.querySelector('.mpl-detail-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
      });
    }

    cardEl.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) {
        close();
      }
    });

    if (typeof document !== 'undefined') {
      keyListener = (e) => {
        if (e.key === 'Escape') {
          close();
        }
      };
      document.addEventListener('keydown', keyListener, true);
    }

    isOpen = true;
    overlayEl.style.display = 'flex';
  }

  return {
    open,
    close,
    isOpen: () => isOpen,
  };
}

module.exports = {
  createLogLineDetailModal,
};
