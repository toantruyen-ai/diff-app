import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Drawer Tabs HTML Structure', () => {
  it('does not contain the Events tab in manage-drawer-tabs', () => {
    const htmlPath = path.resolve(__dirname, '../../../renderer/index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // Extract the <nav class="manage-drawer-tabs"> section
    const navMatch = htmlContent.match(/<nav class="manage-drawer-tabs">([\s\S]*?)<\/nav>/);
    expect(navMatch).not.toBeNull();

    const navContent = navMatch[1];
    expect(navContent).not.toContain('data-tab="events"');
  });
});
