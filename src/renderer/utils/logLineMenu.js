const { escHtml } = require('./htmlUtils');

function createLogLineMenu(menuEl) {
  let isOpen = false;
  let outsideClickListener = null;
  let keyListener = null;

  function close() {
    if (!isOpen && (!menuEl || menuEl.style.display === 'none')) return;
    isOpen = false;
    if (menuEl) {
      menuEl.style.display = 'none';
      menuEl.innerHTML = '';
    }
    if (typeof document !== 'undefined') {
      if (outsideClickListener) {
        document.removeEventListener('click', outsideClickListener, true);
        outsideClickListener = null;
      }
      if (keyListener) {
        document.removeEventListener('keydown', keyListener, true);
        keyListener = null;
      }
    }
  }

  function open(anchorRect, actions = []) {
    close();
    if (!menuEl) return;

    isOpen = true;
    menuEl.innerHTML = actions.map((act, idx) => `
      <div class="mpl-line-menu-item ${act.danger ? 'mpl-danger' : ''}" data-idx="${idx}">
        ${escHtml(act.label)}
      </div>
    `).join('');

    const itemEls = menuEl.querySelectorAll('.mpl-line-menu-item');
    itemEls.forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(el.getAttribute('data-idx'), 10);
        const action = actions[idx];
        close();
        if (action && typeof action.onClick === 'function') {
          action.onClick();
        }
      });
    });

    menuEl.style.position = 'fixed';
    menuEl.style.display = 'block';

    if (anchorRect) {
      const top = (anchorRect.bottom || 0) + 4;
      const left = Math.max(10, (anchorRect.left || 0) - 100);
      menuEl.style.top = `${top}px`;
      menuEl.style.left = `${left}px`;
    }

    if (typeof document !== 'undefined') {
      outsideClickListener = (e) => {
        if (menuEl && !menuEl.contains(e.target)) {
          close();
        }
      };
      keyListener = (e) => {
        if (e.key === 'Escape') {
          close();
        }
      };
      setTimeout(() => {
        if (!isOpen) return;
        document.addEventListener('click', outsideClickListener, true);
        document.addEventListener('keydown', keyListener, true);
      }, 0);
    }
  }

  return {
    open,
    close,
    isOpen: () => isOpen,
  };
}

module.exports = {
  createLogLineMenu,
};
