/**
 * Shared tab utilities — ARIA, keyboard navigation, scroll-into-view, panel transitions.
 *
 * Two modes:
 *  1. Panel-switching tabs (<button> tabs that show/hide content panels)
 *     → use initTabList() for full ARIA + keyboard nav
 *  2. Page-navigating tabs (<a> links that navigate to separate pages)
 *     → use initNavTabList() for lightweight ARIA (role="tablist", aria-current)
 */

// ─── Panel-switching tabs ────────────────────────────────────────────

/**
 * Initialise a panel-switching tab list with full ARIA semantics and keyboard navigation.
 *
 * @param {HTMLElement} tabContainer  - The element wrapping the tab buttons
 * @param {Object}      opts
 * @param {string}      opts.tabSelector    - CSS selector for tab buttons (default: 'button, [role="tab"]')
 * @param {Function}    opts.panelForTab    - (tabEl) => HTMLElement — returns the panel for a given tab
 * @param {Function}    [opts.onSwitch]     - (tabEl) => void — called after switching
 * @param {boolean}     [opts.fade=true]    - use opacity transition instead of display toggle
 * @param {boolean}     [opts.handleClicks=true] - register click handlers on tabs
 */
export function initTabList(tabContainer, opts = {}) {
  if (!tabContainer) return;
  const {
    tabSelector = 'button, [role="tab"]',
    panelForTab,
    onSwitch,
    fade = true,
    handleClicks = true,
  } = opts;

  const tabs = Array.from(tabContainer.querySelectorAll(tabSelector));
  if (!tabs.length) return;

  // --- ARIA on container ---
  tabContainer.setAttribute('role', 'tablist');

  // --- ARIA on each tab + panel ---
  tabs.forEach((tab, i) => {
    const isActive = tab.classList.contains('active');
    const panel = panelForTab?.(tab);

    // Ensure tab has an id for aria-labelledby
    if (!tab.id) tab.id = `tab-${tabContainer.id || 'tl'}-${i}`;

    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(isActive));
    tab.setAttribute('tabindex', isActive ? '0' : '-1');

    if (panel) {
      if (!panel.id) panel.id = `tabpanel-${tabContainer.id || 'tl'}-${i}`;
      tab.setAttribute('aria-controls', panel.id);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.setAttribute('tabindex', '0');

      // Apply fade transition classes
      if (fade) {
        panel.classList.add('tab-panel-fade');
        if (isActive) {
          panel.classList.add('active');
        } else {
          panel.classList.remove('active');
        }
      }
    }
  });

  // --- Click handling ---
  if (handleClicks) {
    tabContainer.addEventListener('click', (e) => {
      const clicked = e.target.closest(tabSelector);
      if (!clicked || !tabs.includes(clicked)) return;
      const idx = tabs.indexOf(clicked);
      activateTab(tabs, idx, panelForTab, onSwitch, fade);
    });
  }

  // --- Keyboard navigation ---
  tabContainer.addEventListener('keydown', (e) => {
    const currentTab = document.activeElement;
    if (!tabs.includes(currentTab)) return;
    const idx = tabs.indexOf(currentTab);
    let nextIdx = -1;

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIdx = (idx + 1) % tabs.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIdx = (idx - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        nextIdx = 0;
        break;
      case 'End':
        nextIdx = tabs.length - 1;
        break;
      default:
        return; // let other keys pass through
    }

    e.preventDefault();
    activateTab(tabs, nextIdx, panelForTab, onSwitch, fade);
  });

  return { tabs, activate: (idx) => activateTab(tabs, idx, panelForTab, onSwitch, fade) };
}

function activateTab(tabs, idx, panelForTab, onSwitch, fade) {
  tabs.forEach((t, i) => {
    const isTarget = i === idx;
    t.classList.toggle('active', isTarget);
    t.setAttribute('aria-selected', String(isTarget));
    t.setAttribute('tabindex', isTarget ? '0' : '-1');

    const panel = panelForTab?.(t);
    if (panel) {
      if (fade) {
        panel.classList.toggle('active', isTarget);
      } else {
        panel.style.display = isTarget ? '' : 'none';
        panel.classList.toggle('active', isTarget);
      }
    }
  });

  tabs[idx]?.focus();
  onSwitch?.(tabs[idx]);
}

// ─── Page-navigating tabs ────────────────────────────────────────────

/**
 * Add lightweight ARIA to a page-navigating tab list (<a> links).
 * Sets role="tablist" on the container and aria-current="page" on the active link.
 *
 * @param {HTMLElement} tabContainer - The .manage-tabs element
 * @param {string}      [linkSelector='a'] - CSS selector for the tab links
 */
export function initNavTabList(tabContainer, linkSelector = 'a') {
  if (!tabContainer) return;
  tabContainer.setAttribute('role', 'tablist');
  const links = tabContainer.querySelectorAll(linkSelector);
  links.forEach(link => {
    link.setAttribute('role', 'tab');
    if (link.classList.contains('active')) {
      link.setAttribute('aria-current', 'page');
      link.setAttribute('aria-selected', 'true');
      link.setAttribute('tabindex', '0');
    } else {
      link.removeAttribute('aria-current');
      link.setAttribute('aria-selected', 'false');
      link.setAttribute('tabindex', '-1');
    }
  });
}

// ─── Scroll active tab into view ─────────────────────────────────────

/**
 * Scroll the active tab into the visible area of its scrollable container.
 * Useful on mobile where tab rows overflow horizontally.
 *
 * @param {HTMLElement} tabContainer - The scrollable .manage-tabs element
 * @param {string}      [activeSelector='.active'] - Selector for the active tab
 */
export function scrollActiveIntoView(tabContainer, activeSelector = '.active') {
  if (!tabContainer) return;
  // Small delay to let the browser finish layout
  requestAnimationFrame(() => {
    const active = tabContainer.querySelector(activeSelector);
    if (active) {
      active.scrollIntoView({ inline: 'center', behavior: 'smooth', block: 'nearest' });
    }
  });
}
