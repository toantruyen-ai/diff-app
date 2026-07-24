import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogLineMenu } from '../../../src/renderer/utils/logLineMenu.js';

describe('logLineMenu', () => {
  let menuEl;

  beforeEach(() => {
    const listeners = {};
    const itemListeners = [];

    menuEl = {
      style: { display: 'none', position: '', top: '', left: '' },
      innerHTML: '',
      contains: vi.fn().mockReturnValue(false),
      querySelectorAll: vi.fn().mockReturnValue([]),
    };
  });

  it('renders menu items safely escaped and opens menu', () => {
    const menu = createLogLineMenu(menuEl);
    menu.open({ bottom: 50, left: 150 }, [
      { label: 'Show <content>', onClick: vi.fn() },
      { label: 'Copy & paste', onClick: vi.fn() },
    ]);

    expect(menu.isOpen()).toBe(true);
    expect(menuEl.style.display).toBe('block');
    expect(menuEl.innerHTML).toContain('Show &lt;content&gt;');
    expect(menuEl.innerHTML).toContain('Copy &amp; paste');
  });

  it('closes menu when close() is called', () => {
    const menu = createLogLineMenu(menuEl);
    menu.open({ bottom: 50, left: 150 }, [{ label: 'Action', onClick: vi.fn() }]);

    expect(menu.isOpen()).toBe(true);
    menu.close();
    expect(menu.isOpen()).toBe(false);
    expect(menuEl.style.display).toBe('none');
  });
});
