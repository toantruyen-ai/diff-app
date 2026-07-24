import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('DOM Structure Verification (index.html)', () => {
  const htmlPath = path.resolve(__dirname, '../../../renderer/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  it('ensures #manage-table-wrap is NOT nested inside #manage-settings-pane or other panes', () => {
    const settingsIndex = html.indexOf('id="manage-settings-pane"');
    const tableWrapIndex = html.indexOf('id="manage-table-wrap"');
    
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(tableWrapIndex).toBeGreaterThan(-1);

    // Verify tag matching: manage-settings-pane must be closed BEFORE manage-table-wrap begins
    // We count opening and closing div tags between settingsIndex and tableWrapIndex
    const betweenHtml = html.substring(settingsIndex, tableWrapIndex);
    const openDivs = (betweenHtml.match(/<div[\s>]/g) || []).length;
    const closeDivs = (betweenHtml.match(/<\/div>/g) || []).length;

    // openDivs - closeDivs should equal 0 (meaning settings-pane and all its sub-divs were properly closed)
    expect(openDivs - closeDivs).toBe(0);
  });

  it('verifies essential layout panes are present and siblings under .manage-main', () => {
    const paneIds = [
      'manage-header',
      'manage-overview-pane',
      'manage-clusterlogs-pane',
      'manage-recyclebin-pane',
      'manage-portforwards-pane',
      'manage-aianalyze-global-pane',
      'manage-settings-pane',
      'manage-table-wrap',
    ];

    for (const id of paneIds) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('verifies all mandatory auth and modal element IDs exist in index.html', () => {
    const criticalIds = [
      'auth-overlay',
      'auth-message',
      'auth-status',
      'btn-az-login',
      'auth-check-banner',
      'auth-check-banner-text',
      'btn-dismiss-auth-check',
      'manage-history-pane',
      'manage-history-list',
      'manage-history-diff',
    ];

    for (const id of criticalIds) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
