import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogLineDetailModal } from '../../../src/renderer/utils/logLineDetailModal.js';

describe('logLineDetailModal', () => {
  let cardEl;
  let overlayEl;

  beforeEach(() => {
    cardEl = {
      innerHTML: '',
      querySelector: vi.fn().mockImplementation((selector) => {
        if (selector === '.mpl-detail-copy-btn' || selector === '.mpl-detail-close-btn') {
          return { addEventListener: vi.fn(), textContent: 'Btn' };
        }
        return null;
      }),
      addEventListener: vi.fn(),
    };

    overlayEl = {
      style: { display: 'none' },
      querySelector: vi.fn().mockReturnValue(cardEl),
      addEventListener: vi.fn(),
    };
  });

  it('renders JSON formatted log line detail modal correctly', () => {
    const modal = createLogLineDetailModal(overlayEl);
    const line = {
      seq: 1,
      pod: 'pod-app-1',
      container: 'main',
      message: '{"user":"admin","status":200}',
    };

    modal.open(line);

    expect(modal.isOpen()).toBe(true);
    expect(overlayEl.style.display).toBe('flex');
    expect(cardEl.innerHTML).toContain('pod-app-1 / main');
    expect(cardEl.innerHTML).toContain('<span class="json-key">&quot;user&quot;</span>');
  });

  it('renders logfmt key-value formatted detail modal correctly', () => {
    const modal = createLogLineDetailModal(overlayEl);
    const line = {
      seq: 2,
      pod: 'pod-app-2',
      container: 'worker',
      message: 'level=info msg="job completed" duration=15ms',
    };

    modal.open(line);

    expect(modal.isOpen()).toBe(true);
    expect(cardEl.innerHTML).toContain('<table class="mpl-detail-kv-table">');
    expect(cardEl.innerHTML).toContain('mpl-detail-kv-key">level</td>');
    expect(cardEl.innerHTML).toContain('mpl-detail-kv-val">job completed</td>');
  });

  it('closes modal on close() call', () => {
    const modal = createLogLineDetailModal(overlayEl);
    modal.open({ seq: 1, message: 'test' });
    expect(modal.isOpen()).toBe(true);

    modal.close();
    expect(modal.isOpen()).toBe(false);
    expect(overlayEl.style.display).toBe('none');
  });
});
