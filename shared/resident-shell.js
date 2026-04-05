/**
 * Resident Shell - Shared module for all resident pages
 * Provides: auth flow, tab navigation, toast notifications, lightbox
 * Cloned from admin-shell.js with resident-specific tab config
 */

import { supabase } from './supabase.js';
import { initAuth, getAuthState, signOut, onAuthStateChange, hasAnyPermission } from './auth.js';
import { errorLogger } from './error-logger.js';
import { supabaseHealth } from './supabase-health.js';
import { initPaiWidget } from './pai-widget.js';
import { setupVersionInfo } from './version-info.js';
import { renderHeader, initSiteComponents } from './site-components.js';
import { initNavTabList, scrollActiveIntoView } from './tab-utils.js';
import { getEnabledFeatures } from './feature-registry.js';
import { STAFF_PERMISSION_KEYS, ADMIN_PERMISSION_KEYS, DEVICE_PERMISSION_KEYS, renderContextSwitcher } from './context-switcher.js';

// =============================================
// TAB DEFINITIONS
// =============================================

const DEVICE_PAGE_PATHS = new Set([
  'devices.html', 'devices',
  '3dprinter.html', '3dprinter',
  'lighting.html', 'lighting',
  'sonos.html', 'sonos',
  'cameras.html', 'cameras',
  'climate.html', 'climate',
  'appliances.html', 'appliances',
  'laundry.html', 'laundry', // redirect stub compat
  'cars.html', 'cars',
  'sensors.html', 'sensors',
]);

// Compact SVG icons for tabs (16x16, stroke-based)
const _i = (d) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TAB_ICONS = {
  list:       _i('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>'),
  homeauto:   _i('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 018.91 14"/>'),
  music:      _i('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  cameras:    _i('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>'),
  climate:    _i('<path d="M14 14.76V3.5a2.5 2.5 0 00-5 0v11.26a4.5 4.5 0 105 0z"/>'),
  appliances: _i('<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="6" x2="12.01" y2="6"/>'),
  cars:       _i('<path d="M5 17h14v-3l2-4H3l2 4v3z"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/><path d="M5 10l1.5-4h11L19 10"/>'),
  sensors:    _i('<path d="M2 12C2 6.48 6.48 2 12 2s10 4.48 10 10"/><path d="M7 12a5 5 0 015-5"/><circle cx="12" cy="12" r="1"/>'),
  printer3d:  _i('<rect x="4" y="3" width="16" height="4" rx="1"/><path d="M7 7v7a5 5 0 0010 0V7"/><rect x="9" y="14" width="6" height="7" rx="1"/>'),
  profile:    _i('<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  bookkeeping:_i('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>'),
  media:      _i('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
  askpai:     _i('<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>'),
};

const DEVICE_SUBTABS = [
  { id: 'list', label: 'List', href: 'devices.html', permissionsAny: DEVICE_PERMISSION_KEYS },
  { id: 'homeauto', label: 'Lighting', href: 'lighting.html', permission: 'view_lighting', feature: 'lighting' },
  { id: 'music', label: 'Music', href: 'sonos.html', permission: 'view_music', feature: 'music' },
  { id: 'cameras', label: 'Cameras', href: 'cameras.html', permission: 'view_cameras', feature: 'cameras' },
  { id: 'climate', label: 'Climate', href: 'climate.html', permission: 'view_climate', feature: 'climate' },
  { id: 'appliances', label: 'Appliances', href: 'appliances.html', permission: 'view_laundry', feature: 'oven' },
  { id: 'cars', label: 'Cars', href: 'cars.html', permission: 'view_cars', feature: 'vehicles' },
  { id: 'sensors', label: 'Sensors', href: 'sensors.html', permission: 'view_cameras', feature: 'cameras' },
  { id: 'printer3d', label: '3D Printer', href: '3dprinter.html', permission: 'view_printer', feature: 'printer_3d' },
];

const RESIDENT_CORE_TABS = [
  { id: 'profile', label: 'Profile', href: 'profile.html', permission: 'view_profile' },
  { id: 'bookkeeping', label: 'Bookkeeping', href: 'bookkeeping.html', permission: 'view_profile' },
  { id: 'media', label: 'Imagery', href: 'media.html', permission: 'view_profile' },
  { id: 'askpai', label: 'Ask PAI', href: 'ask-pai.html', permission: 'view_profile', feature: 'pai' },
];

const RESIDENT_STAFF_TABS = [
  { id: 'profile', label: 'Profile', href: 'profile.html', permission: 'view_profile' },
  { id: 'bookkeeping', label: 'Bookkeeping', href: 'bookkeeping.html', permission: 'view_profile' },
  { id: 'media', label: 'Imagery', href: 'media.html', permission: 'view_profile' },
  { id: 'askpai', label: 'Ask PAI', href: 'ask-pai.html', permission: 'view_profile', feature: 'pai' },
];

// =============================================
// TOAST NOTIFICATIONS
// =============================================
export function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    success: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>',
    error: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>',
    warning: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>',
    info: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>'
  };

  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-message">${message}</span>
    <button class="toast-close" onclick="this.parentElement.remove()">&times;</button>
  `;

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }
}

// =============================================
// TAB NAVIGATION
// =============================================
async function renderResidentTabNav(activeTab, authState) {
  const tabsContainer = document.querySelector('.manage-tabs');
  if (!tabsContainer) return;

  // Show context switcher for users with any staff/admin permissions (or admin/oracle role)
  const role = authState.appUser?.role;
  const isAdminRole = role === 'admin' || role === 'oracle';
  const switcher = document.getElementById('contextSwitcher');
  if (switcher) {
    const hasStaffPerms = isAdminRole || authState.hasAnyPermission?.(...STAFF_PERMISSION_KEYS);
    const hasAdminPerms = isAdminRole || authState.hasAnyPermission?.(...ADMIN_PERMISSION_KEYS);
    if (hasStaffPerms || hasAdminPerms) {
      switcher.classList.remove('hidden');
    }
  }

  const hasStaffPerms = isAdminRole || authState.hasAnyPermission?.(...STAFF_PERMISSION_KEYS);
  const hasAdminPerms = isAdminRole || authState.hasAnyPermission?.(...ADMIN_PERMISSION_KEYS);
  const isStaffContext = hasStaffPerms || hasAdminPerms;
  const availableTabs = isStaffContext ? RESIDENT_STAFF_TABS : RESIDENT_CORE_TABS;

  // On device pages, hide resident-level tabs — only show device sub-tabs
  const currentPath = normalizeRouteToken(window.location.pathname.split('/').pop() || '');
  const isDevicePage = activeTab === 'devices' || DEVICE_PAGE_PATHS.has(currentPath);

  if (isDevicePage) {
    tabsContainer.innerHTML = '';
    tabsContainer.style.display = 'none';
    await renderDeviceSubTabNav(activeTab, authState);
    return;
  }

  // Filter tabs by enabled features AND permission
  const enabledFeatures = await getEnabledFeatures();
  const tabs = availableTabs
    .filter(tab => !tab.feature || enabledFeatures[tab.feature])
    .filter((tab) => {
      if (Array.isArray(tab.permissionsAny) && tab.permissionsAny.length > 0) {
        return tab.permissionsAny.some((perm) => authState.hasPermission?.(perm));
      }
      return authState.hasPermission?.(tab.permission);
    });

  tabsContainer.innerHTML = tabs.map(tab => {
    const isActive = tab.id === activeTab;
    const icon = TAB_ICONS[tab.id] || '';
    return `<a href="${tab.href}" class="manage-tab${isActive ? ' active' : ''}">${icon}${tab.label}</a>`;
  }).join('');

  // ARIA + auto-scroll active tab into view on mobile
  initNavTabList(tabsContainer, '.manage-tab');
  if (switcher) initNavTabList(switcher, '.context-switcher-btn');
  scrollActiveIntoView(tabsContainer);
}

function hasTabAccess(tab, authState) {
  // Admin/oracle users bypass permission checks — they have access to everything
  const role = authState.appUser?.role;
  if (role === 'admin' || role === 'oracle') return true;

  if (Array.isArray(tab.permissionsAny) && tab.permissionsAny.length > 0) {
    return tab.permissionsAny.some((perm) => authState.hasPermission?.(perm));
  }
  return authState.hasPermission?.(tab.permission);
}

async function renderDeviceSubTabNav(activeTab, authState) {
  const currentPath = normalizeRouteToken(window.location.pathname.split('/').pop() || '');
  const devicePageToTab = {
    'devices.html': 'list',
    devices: 'list',
    '3dprinter.html': 'printer3d',
    '3dprinter': 'printer3d',
    'lighting.html': 'homeauto',
    lighting: 'homeauto',
    'sonos.html': 'music',
    sonos: 'music',
    'cameras.html': 'cameras',
    cameras: 'cameras',
    'climate.html': 'climate',
    climate: 'climate',
    'appliances.html': 'appliances',
    appliances: 'appliances',
    'laundry.html': 'appliances',
    laundry: 'appliances',
    'cars.html': 'cars',
    cars: 'cars',
    'sensors.html': 'sensors',
    sensors: 'sensors',
  };
  const activeDeviceSubTab = devicePageToTab[currentPath] || (activeTab === 'devices' ? 'list' : null);
  const shouldRenderDeviceSubtabs = activeTab === 'devices' || Boolean(devicePageToTab[currentPath]);

  let subTabContainer = document.getElementById('deviceSubTabNav');
  if (!shouldRenderDeviceSubtabs) {
    if (subTabContainer) subTabContainer.remove();
    return;
  }

  const enabledFeatures = await getEnabledFeatures();
  const visibleSubtabs = DEVICE_SUBTABS
    .filter(tab => !tab.feature || enabledFeatures[tab.feature])
    .filter((tab) => hasTabAccess(tab, authState));
  if (visibleSubtabs.length === 0) {
    if (subTabContainer) subTabContainer.remove();
    return;
  }

  if (!subTabContainer) {
    subTabContainer = document.createElement('div');
    subTabContainer.id = 'deviceSubTabNav';
    subTabContainer.className = 'manage-tabs';
    const tabsContainer = document.querySelector('.manage-tabs');
    tabsContainer.insertAdjacentElement('afterend', subTabContainer);
  }

  subTabContainer.innerHTML = visibleSubtabs.map((tab) => {
    const isActive = tab.id === activeDeviceSubTab;
    const icon = TAB_ICONS[tab.id] || '';
    return `<a href="${tab.href}" class="manage-tab${isActive ? ' active' : ''}">${icon}${tab.label}</a>`;
  }).join('');

  // ARIA + auto-scroll active tab into view on mobile
  initNavTabList(subTabContainer, '.manage-tab');
  scrollActiveIntoView(subTabContainer);
}

function normalizeRouteToken(token) {
  const normalized = String(token || '').trim().toLowerCase();
  if (!normalized) return '';
  return normalized.endsWith('.html') ? normalized : normalized;
}

// Context switcher imported from ./context-switcher.js

// =============================================
// USER INFO (HEADER AVATAR + NAME)
// =============================================

function renderUserInfo(el, appUser, profileHref) {
  if (!el) return;
  const name = appUser.display_name || appUser.email;
  const initials = getInitials(name);
  const avatarUrl = appUser.avatar_url;

  const avatarHtml = avatarUrl
    ? `<img src="${avatarUrl}" alt="" class="user-avatar">`
    : `<span class="user-avatar user-avatar--initials">${initials}</span>`;

  // Role-based navigation links
  const role = appUser.role || '';
  const isStaffOrAdmin = ['admin', 'oracle', 'staff'].includes(role);
  const manageLink = isStaffOrAdmin
    ? `<a href="/spaces/admin/spaces.html" class="user-menu-item">Manage</a>`
    : '';

  el.innerHTML = `
    <button class="user-menu-trigger" aria-haspopup="true" aria-expanded="false">
      ${avatarHtml}<span class="user-profile-name">${escapeHtml(name)}</span>
    </button>
    <div class="user-menu-dropdown hidden">
      <div id="roleBadge" class="role-badge dropdown-role-badge" style="display:none"></div>
      <a href="${profileHref}" class="user-menu-item">Profile</a>
      ${manageLink}
      <button type="button" class="user-menu-item user-menu-signout" id="headerSignOutBtn">Sign Out</button>
    </div>`;

  const trigger = el.querySelector('.user-menu-trigger');
  const dropdown = el.querySelector('.user-menu-dropdown');
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !dropdown.classList.contains('hidden');
    dropdown.classList.toggle('hidden', open);
    trigger.setAttribute('aria-expanded', !open);
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && trigger !== e.target && !trigger.contains(e.target)) {
      dropdown.classList.add('hidden');
      trigger.setAttribute('aria-expanded', 'false');
    }
  });
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name[0].toUpperCase();
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// =============================================
// SITE NAV INJECTION
// =============================================
let siteNavInitialized = false;

function injectSiteNav() {
  if (siteNavInitialized) return;
  const target = document.getElementById('siteHeader');
  if (!target) return;

  const versionEl = document.querySelector('[data-site-version]');
  const version = versionEl?.textContent?.trim() || '';

  target.innerHTML = renderHeader({
    transparent: false,
    light: false,
    version,
    showRoleBadge: true,
  });

  initSiteComponents();
  setupVersionInfo();
  siteNavInitialized = true;
}

// =============================================
// ACCESS DENIED OVERLAY
// =============================================

function renderAccessDenied(state, activeTab) {
  const overlay = document.getElementById('unauthorizedOverlay');
  if (!overlay) return;

  const displayName = state.appUser?.display_name || state.appUser?.email || state.user?.email || 'Unknown';
  const role = state.appUser?.role || 'none';
  const email = state.appUser?.email || state.user?.email || '';
  const pageName = document.title?.split(' - ')[0] || activeTab || window.location.pathname.split('/').pop()?.replace('.html', '') || 'this page';

  overlay.innerHTML = `
    <div class="unauthorized-card">
      <h2>Access Denied</h2>
      <p style="font-size:1.05em;color:var(--text);margin-bottom:0.25rem"><strong>${escapeHtml(displayName)}</strong></p>
      <p style="opacity:0.6;font-size:0.85em;margin-bottom:1rem">${escapeHtml(role)}</p>
      <p style="color:var(--text-muted)">You are trying to access <strong>${escapeHtml(pageName)}</strong>, for which you don't have permission.</p>
      <p style="color:var(--text-muted);font-size:0.85em;margin-top:0.75rem">You may request access below.</p>
      <div style="margin-top:1rem">
        <textarea id="accessRequestMsg" rows="2" placeholder="Reason for access (optional)" style="width:100%;padding:0.5rem 0.75rem;border:1px solid var(--border,#ddd);border-radius:8px;font-family:inherit;font-size:0.85rem;resize:vertical;background:var(--bg,#fff);color:var(--text,#333)"></textarea>
      </div>
      <div class="unauthorized-actions" style="flex-direction:column;align-items:stretch">
        <button id="requestAccessBtn" class="btn-secondary" style="background:var(--accent,#d4883a);color:#fff;border:none;padding:0.6rem 1rem;border-radius:8px;cursor:pointer;font-weight:600">Request Access</button>
        <div style="display:flex;gap:0.75rem;justify-content:center">
          <a href="/spaces/" class="btn-secondary">View Public Spaces</a>
          <button id="signOutBtn" class="btn-secondary">Sign Out</button>
        </div>
      </div>
    </div>
  `;

  // Wire up Sign Out
  const signOutBtn = overlay.querySelector('#signOutBtn');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      await signOut();
      window.location.href = '/login/';
    });
  }

  // Wire up Request Access
  const requestBtn = overlay.querySelector('#requestAccessBtn');
  if (requestBtn) {
    requestBtn.addEventListener('click', async () => {
      requestBtn.disabled = true;
      requestBtn.textContent = 'Sending...';
      try {
        const msg = overlay.querySelector('#accessRequestMsg')?.value?.trim() || '';
        await supabase.functions.invoke('send-email', {
          body: {
            template: 'access_request',
            to: 'team@alpacaplayhouse.com',
            data: {
              user_name: displayName,
              user_email: email,
              user_role: role,
              page_name: pageName,
              page_url: window.location.href,
              message: msg
            }
          }
        });
        requestBtn.textContent = 'Request Sent';
        requestBtn.style.opacity = '0.6';
      } catch (e) {
        console.error('Failed to send access request:', e);
        requestBtn.textContent = 'Failed — try again';
        requestBtn.disabled = false;
      }
    });
  }
}

// =============================================
// AUTH & PAGE INITIALIZATION
// =============================================

/**
 * Initialize a resident page with auth flow.
 * @param {Object} options
 * @param {string} options.activeTab - Which tab to highlight in nav
 * @param {string} options.requiredRole - Minimum role required ('resident', 'staff', or 'admin'). Default: 'resident'
 * @param {Function} options.onReady - Called with authState when authorized
 * @returns {Promise<Object>} authState
 */
export async function initResidentPage({ activeTab, requiredRole = 'resident', requiredPermission, onReady }) {
  // Set up global error handlers + health banner
  errorLogger.setupGlobalHandlers();
  supabaseHealth.injectBanner();

  function removeStrayBootLogos() {
    const topLevelLogoSelectors = [
      '#loadingOverlay .loading-overlay__logo',
      '#appContent > .loading-overlay__logo',
      '#appContent > img[src*="/housephotos/logos/alpaca-head-black-transparent.png"]',
    ];
    document.querySelectorAll(topLevelLogoSelectors.join(',')).forEach((el) => el.remove());
  }

  removeStrayBootLogos();
  const rootEl = document.documentElement;
  const loadingOverlayEl = document.getElementById('loadingOverlay');
  loadingOverlayEl?.querySelector('.loading-overlay__logo')?.classList.add('hidden');
  const unauthorizedOverlayEl = document.getElementById('unauthorizedOverlay');
  const appContentEl = document.getElementById('appContent');
  let hasCachedAuthHint = rootEl.hasAttribute('data-cached-auth');
  if (!hasCachedAuthHint) {
    try {
      const raw = localStorage.getItem('genalpaca-cached-auth');
      if (raw) {
        const cached = JSON.parse(raw);
        const ageMs = Date.now() - (cached?.timestamp || 0);
        const likelyValid = ageMs >= 0 && ageMs <= 90 * 24 * 60 * 60 * 1000;
        const hasIdentity = !!(cached?.appUser || cached?.userId || cached?.email);
        if (likelyValid && hasIdentity) {
          hasCachedAuthHint = true;
          rootEl.setAttribute('data-cached-auth', '1');
        }
      }
    } catch (e) {
      // Ignore parse/storage errors and continue normal boot.
    }
  }
  let authState = getAuthState();
  let pageContentShown = false;
  let onReadyCalled = false;
  let bootState = 'init';

  function transitionBootState(nextState) {
    if (bootState === nextState) return;
    bootState = nextState;

    if (nextState !== 'booting') rootEl.removeAttribute('data-cached-auth');

    if (nextState === 'booting') {
      unauthorizedOverlayEl?.classList.add('hidden');
      if (hasCachedAuthHint) {
        // Keep cached sessions loaderless to avoid white flash.
        loadingOverlayEl?.classList.add('hidden');
      } else {
        loadingOverlayEl?.classList.remove('hidden');
      }
      return;
    }

    if (nextState === 'authorized') {
      loadingOverlayEl?.classList.add('hidden');
      unauthorizedOverlayEl?.classList.add('hidden');
      appContentEl?.classList.remove('hidden');
      return;
    }

    if (nextState === 'unauthorized') {
      loadingOverlayEl?.classList.add('hidden');
      appContentEl?.classList.add('hidden');
      unauthorizedOverlayEl?.classList.remove('hidden');
      return;
    }

    if (nextState === 'redirecting') {
      loadingOverlayEl?.classList.add('hidden');
    }
  }

  transitionBootState('booting');
  removeStrayBootLogos();
  await initAuth();
  authState = getAuthState();

  async function handleAuthState(state) {
    authState = state;

    // Set user context for error logging
    if (state.appUser) {
      errorLogger.setUserContext({
        userId: state.appUser.id,
        role: state.appUser.role,
        email: state.appUser.email,
      });
    }

    // Check if user meets the required permission or role
    const userRole = state.appUser?.role;
    let meetsRequirement;
    if (requiredPermission) {
      meetsRequirement = state.hasPermission?.(requiredPermission);
      // If permissions haven't loaded yet (empty set from cache/timeout) but the user's
      // role would normally grant access, don't deny — keep loading and wait for fresh perms.
      if (!meetsRequirement && state.permissions?.size === 0) {
        const ROLE_LEVEL = { oracle: 4, admin: 3, staff: 2, demo: 2, resident: 1, associate: 1 };
        const userLevel = ROLE_LEVEL[userRole] || 0;
        const requiredLevel = ROLE_LEVEL[requiredRole] || 0;
        if (userLevel >= requiredLevel) {
          return;
        }
      }
    } else {
      const ROLE_LEVEL = { oracle: 4, admin: 3, staff: 2, demo: 2, resident: 1, associate: 1 };
      const userLevel = ROLE_LEVEL[userRole] || 0;
      const requiredLevel = ROLE_LEVEL[requiredRole] || 0;
      meetsRequirement = userLevel >= requiredLevel;
    }

    if (state.appUser && meetsRequirement) {
      transitionBootState('authorized');
      injectSiteNav();

      // Render user info into site nav auth container (replaces Sign In link)
      const siteAuthEl = document.getElementById('aapHeaderAuth');
      const legacyUserInfo = document.getElementById('userInfo');
      if (siteAuthEl) {
        renderUserInfo(siteAuthEl, state.appUser, 'profile.html');
        siteAuthEl.classList.add('user-info');
        const signInLink = document.getElementById('aapSignInLink');
        if (signInLink) signInLink.style.display = 'none';
        const mobileSignInLink = document.getElementById('aapMobileSignInLink');
        if (mobileSignInLink) mobileSignInLink.closest('li')?.remove();
        if (legacyUserInfo) legacyUserInfo.style.display = 'none';
      } else if (legacyUserInfo) {
        renderUserInfo(legacyUserInfo, state.appUser, 'profile.html');
      }

      // Update role badge and admin-only visibility
      const roleBadge = document.getElementById('roleBadge');
      if (roleBadge) {
        const role = state.appUser.role || 'resident';
        roleBadge.textContent = role.charAt(0).toUpperCase() + role.slice(1);
        roleBadge.className = 'role-badge ' + role;
        roleBadge.style.display = '';
      }
      if (['admin', 'oracle'].includes(state.appUser.role)) {
        document.body.classList.add('is-admin');
      } else {
        document.body.classList.remove('is-admin');
      }

      // Determine active context from current path
      const currentPath = normalizeRouteToken(window.location.pathname.split('/').pop() || '');
      const activeContext = DEVICE_PAGE_PATHS.has(currentPath) ? 'devices' : 'resident';
      await renderContextSwitcher({ activeSection: activeContext, userRole: state.appUser?.role });
      // Render tab navigation (pass full auth state for permission checks)
      await renderResidentTabNav(activeTab, state);

      // Sign out handlers + PAI widget + version info (only bind once). Use delegation on userInfo so header dropdown Sign Out is reliable.
      if (!pageContentShown) {
        const handleSignOut = async () => {
          await signOut();
          window.location.href = '/login/';
        };
        document.getElementById('signOutBtn')?.addEventListener('click', handleSignOut);
        const userInfoEl = document.getElementById('userInfo') || document.getElementById('aapHeaderAuth');
        userInfoEl?.addEventListener('click', (e) => {
          if (e.target.closest('#headerSignOutBtn') || e.target.closest('.user-menu-signout')) {
            e.preventDefault();
            e.stopPropagation();
            handleSignOut();
          }
        });
        initPaiWidget();
        setupVersionInfo();
      }

      pageContentShown = true;
      if (onReady && !onReadyCalled) {
        onReadyCalled = true;
        // Ensure Supabase has a real session before onReady queries RLS-protected tables.
        // Cached auth resolves initAuth() before the JWT is ready, so getSession() forces
        // the client to establish the actual session first.
        let { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData?.session) {
          // JWT expired (common on mobile after backgrounding) — try refreshing
          console.warn('[resident-shell] No active session — attempting token refresh');
          const { data: refreshData } = await supabase.auth.refreshSession();
          sessionData = refreshData;
        }
        if (!sessionData?.session) {
          // Refresh also failed — force re-login
          console.warn('[resident-shell] Token refresh failed — redirecting to login');
          try { localStorage.removeItem('genalpaca-cached-auth'); } catch (e) { /* ignore */ }
          transitionBootState('redirecting');
          window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
          return;
        }
        onReady(state);
      }
    } else if (state.appUser || (state.isAuthenticated && state.isUnauthorized)) {
      // If the page was already authorized and working, don't disrupt it with a
      // transient auth failure (e.g. app_users query timeout during token refresh).
      if (onReadyCalled) {
        console.warn('[resident-shell] Transient auth state change after page authorized — keeping current state');
        return;
      }
      transitionBootState('unauthorized');
      renderAccessDenied(state, activeTab);
    } else if (!state.isAuthenticated && !pageContentShown) {
      transitionBootState('redirecting');
      window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
    }
  }

  onAuthStateChange(handleAuthState);
  handleAuthState(authState);

  return authState;
}

// =============================================
// LIGHTBOX
// =============================================
let lightboxGallery = [];
let lightboxIndex = 0;
let currentGalleryUrls = [];

export function setCurrentGallery(photos) {
  currentGalleryUrls = photos.map(p => p.url);
}

export function openLightbox(imageUrl, galleryUrls = null) {
  const lightbox = document.getElementById('imageLightbox');
  const lightboxImage = document.getElementById('lightboxImage');
  if (lightbox && lightboxImage) {
    if (galleryUrls && galleryUrls.length > 0) {
      lightboxGallery = [...galleryUrls];
      lightboxIndex = lightboxGallery.indexOf(imageUrl);
      if (lightboxIndex === -1) lightboxIndex = 0;
    } else if (currentGalleryUrls.length > 0 && currentGalleryUrls.includes(imageUrl)) {
      lightboxGallery = [...currentGalleryUrls];
      lightboxIndex = lightboxGallery.indexOf(imageUrl);
    } else {
      lightboxGallery = [imageUrl];
      lightboxIndex = 0;
    }
    lightboxImage.src = imageUrl;
    lightbox.classList.remove('hidden');
    updateLightboxNav();
  }
}

function updateLightboxNav() {
  const prevBtn = document.getElementById('lightboxPrev');
  const nextBtn = document.getElementById('lightboxNext');
  if (prevBtn && nextBtn) {
    const showNav = lightboxGallery.length > 1;
    prevBtn.style.display = showNav ? 'flex' : 'none';
    nextBtn.style.display = showNav ? 'flex' : 'none';
  }
}

export function lightboxPrev() {
  if (lightboxIndex > 0) {
    lightboxIndex--;
    document.getElementById('lightboxImage').src = lightboxGallery[lightboxIndex];
    updateLightboxNav();
  }
}

export function lightboxNext() {
  if (lightboxIndex < lightboxGallery.length - 1) {
    lightboxIndex++;
    document.getElementById('lightboxImage').src = lightboxGallery[lightboxIndex];
    updateLightboxNav();
  }
}

export function closeLightbox() {
  const lightbox = document.getElementById('imageLightbox');
  if (lightbox) {
    lightbox.classList.add('hidden');
    document.getElementById('lightboxImage').src = '';
    lightboxGallery = [];
    lightboxIndex = 0;
  }
}

/**
 * Set up lightbox event listeners. Call once on page init.
 */
export function setupLightbox() {
  const lightbox = document.getElementById('imageLightbox');
  if (!lightbox) return;

  lightbox.querySelector('.lightbox-close')?.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.getElementById('lightboxPrev')?.addEventListener('click', (e) => {
    e.stopPropagation();
    lightboxPrev();
  });
  document.getElementById('lightboxNext')?.addEventListener('click', (e) => {
    e.stopPropagation();
    lightboxNext();
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('hidden')) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') lightboxPrev();
      if (e.key === 'ArrowRight') lightboxNext();
    }
  });
}
