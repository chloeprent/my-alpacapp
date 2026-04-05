/**
 * Associate Shell - Shared module for all associate pages
 * Provides: auth flow, tab navigation, context switcher, toast notifications
 * Cloned from resident-shell.js with associate-specific tab config
 */

import { supabase } from './supabase.js';
import { initAuth, getAuthState, signOut, onAuthStateChange, hasAnyPermission } from './auth.js';
import { errorLogger } from './error-logger.js';
import { setupVersionInfo } from './version-info.js';
import { renderHeader, initSiteComponents } from './site-components.js';
import { renderContextSwitcher } from './context-switcher.js';

// =============================================
// TAB DEFINITIONS
// =============================================

const ASSOCIATE_TABS = [
  { id: 'hours', label: 'Work Planning', href: 'worktracking.html' },
  { id: 'projects', label: 'Projects', href: 'projects.html' },
  { id: 'inquiry', label: 'Project Inquiry', href: 'projectinquiry.html' },
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
function renderAssociateTabNav(activeTab) {
  const tabsContainer = document.querySelector('.manage-tabs');
  if (!tabsContainer) return;

  tabsContainer.innerHTML = ASSOCIATE_TABS.map(tab => {
    const isActive = tab.id === activeTab;
    return `<a href="${tab.href}" class="manage-tab${isActive ? ' active' : ''}">${tab.label}</a>`;
  }).join('');
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

  el.innerHTML = `
    <button class="user-menu-trigger" aria-haspopup="true" aria-expanded="false">
      ${avatarHtml}<span class="user-profile-name">${escapeHtml(name)}</span>
    </button>
    <div class="user-menu-dropdown hidden">
      <div id="roleBadge" class="role-badge dropdown-role-badge" style="display:none"></div>
      <a href="${profileHref}" class="user-menu-item">Profile</a>
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
// AUTH & PAGE INITIALIZATION
// =============================================

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

/**
 * Initialize an associate page with auth flow.
 * @param {Object} options
 * @param {string} options.activeTab - Which tab to highlight in nav
 * @param {Function} options.onReady - Called with authState when authorized
 * @returns {Promise<Object>} authState
 */
export async function initAssociatePage({ activeTab, onReady }) {
  // Set up global error handlers
  errorLogger.setupGlobalHandlers();

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

    // Associates, staff, admin, and oracle can access associate pages
    const userRole = state.appUser?.role;
    const allowedRoles = ['associate', 'staff', 'admin', 'oracle', 'demo'];
    const meetsRequirement = allowedRoles.includes(userRole);

    if (state.appUser && meetsRequirement) {
      transitionBootState('authorized');
      injectSiteNav();

      // Render user info into site nav auth container (replaces Sign In link)
      const siteAuthEl = document.getElementById('aapHeaderAuth');
      const legacyUserInfo = document.getElementById('userInfo');
      if (siteAuthEl) {
        renderUserInfo(siteAuthEl, state.appUser, '/residents/profile.html');
        siteAuthEl.classList.add('user-info');
        const signInLink = document.getElementById('aapSignInLink');
        if (signInLink) signInLink.style.display = 'none';
        const mobileSignInLink = document.getElementById('aapMobileSignInLink');
        if (mobileSignInLink) mobileSignInLink.closest('li')?.remove();
        if (legacyUserInfo) legacyUserInfo.style.display = 'none';
      } else if (legacyUserInfo) {
        renderUserInfo(legacyUserInfo, state.appUser, '/residents/profile.html');
      }

      // Update role badge
      const roleBadge = document.getElementById('roleBadge');
      if (roleBadge) {
        const role = state.appUser.role || 'associate';
        roleBadge.textContent = role.charAt(0).toUpperCase() + role.slice(1);
        roleBadge.className = 'role-badge ' + role;
        roleBadge.style.display = '';
      }

      await renderContextSwitcher({ activeSection: 'associate', userRole: state.appUser?.role });
      renderAssociateTabNav(activeTab);

      // Sign out handlers + version info (only bind once). Use delegation on userInfo so header dropdown Sign Out is reliable.
      if (!pageContentShown) {
        const handleSignOut = async () => {
          await signOut();
          window.location.href = '/login/';
        };
        document.getElementById('signOutBtn')?.addEventListener('click', handleSignOut);
        const userInfo = document.getElementById('userInfo');
        userInfo?.addEventListener('click', (e) => {
          if (e.target.closest('#headerSignOutBtn') || e.target.closest('.user-menu-signout')) {
            e.preventDefault();
            e.stopPropagation();
            handleSignOut();
          }
        });
        setupVersionInfo();
      }

      pageContentShown = true;
      if (onReady && !onReadyCalled) {
        onReadyCalled = true;
        // Ensure Supabase has a real session before onReady queries RLS-protected tables.
        let { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData?.session) {
          // JWT expired (common on mobile after backgrounding) — try refreshing
          console.warn('[associate-shell] No active session — attempting token refresh');
          const { data: refreshData } = await supabase.auth.refreshSession();
          sessionData = refreshData;
        }
        if (!sessionData?.session) {
          // Refresh also failed — force re-login
          console.warn('[associate-shell] Token refresh failed — redirecting to login');
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
        console.warn('[associate-shell] Transient auth state change after page authorized — keeping current state');
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
