/**
 * Personal Page Shell — Auth gate + header + privacy controls for personal pages
 *
 * Sits between public-shell.js (no auth) and resident-shell.js (heavy auth + tabs).
 * Default: requires authentication, any registered user can view.
 * Owners (admin/oracle) see a floating settings FAB to manage visibility + grants.
 */

import { supabase } from './supabase.js';
import { initAuth, getAuthState, signOut, onAuthStateChange } from './auth.js';
import { renderHeader, initSiteComponents, initPublicHeaderAuth } from './site-components.js';
import { setupVersionInfo } from './version-info.js';

// ── Constants ──────────────────────────────────────────────────────────
const ROLE_LEVEL = { oracle: 4, admin: 3, staff: 2, demo: 2, resident: 1, associate: 1, public: 0 };
const VISIBILITY_OPTIONS = [
  { value: 'public',         label: 'Public',    icon: 'globe',  desc: 'Anyone — no login required' },
  { value: 'registered',     label: 'Registered', icon: 'person', desc: 'Any signed-in user' },
  { value: 'role:resident',  label: 'Residents',  icon: 'people', desc: 'Residents and above' },
  { value: 'role:staff',     label: 'Staff',      icon: 'shield', desc: 'Staff and above' },
  { value: 'role:admin',     label: 'Admins',     icon: 'key',    desc: 'Admins only' },
  { value: 'private',        label: 'Private',    icon: 'lock',   desc: 'Only me + granted emails' },
];

const VIS_COLORS = {
  'public':        '#16a34a', // green
  'registered':    '#d4883a', // amber
  'role:resident': '#2563eb', // blue
  'role:staff':    '#7c3aed', // violet
  'role:admin':    '#c026d3', // fuchsia
  'private':       '#dc2626', // red
};

const ICONS = {
  globe:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z"/></svg>',
  person: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  people: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
  shield: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  key:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
  lock:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>',
  settings:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
  x:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  copy:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
  trash:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>',
};

// ── State ──────────────────────────────────────────────────────────────
let pagePath = '';
let pageSettings = null;   // { page_path, visibility }
let pageGrants = [];       // [{ email, granted_at }]
let isOwner = false;
let authState = null;

// ── Helpers ────────────────────────────────────────────────────────────
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function getPagePath() {
  let p = window.location.pathname;
  // Normalize: ensure leading /, strip trailing / only if it's not just /
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

function getVisibilityLabel(v) {
  return VISIBILITY_OPTIONS.find(o => o.value === v)?.label || v;
}

function getVisibilityIcon(v) {
  const opt = VISIBILITY_OPTIONS.find(o => o.value === v);
  return opt ? ICONS[opt.icon] : ICONS.settings;
}

function updateSettingsButtonIcon() {
  const btn = document.getElementById('ppSettingsBtn');
  if (!btn) return;
  const vis = pageSettings?.visibility || 'registered';
  const color = VIS_COLORS[vis] || '#8c8279';
  btn.innerHTML = getVisibilityIcon(vis);
  btn.style.color = color;
}

function showToast(msg, type = 'info', duration = 4000) {
  // Use existing toast container or create one
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;top:1rem;right:1rem;z-index:99999;display:flex;flex-direction:column;gap:0.5rem;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  const colors = {
    success: 'background:#d1fae5;color:#065f46;',
    error:   'background:#fee2e2;color:#991b1b;',
    info:    'background:#dbeafe;color:#1e40af;',
  };
  toast.style.cssText = `padding:0.6rem 1rem;border-radius:8px;font-size:0.85rem;font-weight:500;font-family:'DM Sans',sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.12);animation:ppToastIn 0.2s ease-out;${colors[type] || colors.info}`;
  toast.textContent = msg;
  container.appendChild(toast);
  if (duration > 0) {
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 200); }, duration);
  }
}

// ── Access Check ───────────────────────────────────────────────────────
function checkAccess(state, settings, grants) {
  if (!state?.appUser) return false;

  const visibility = settings?.visibility || 'registered';
  const userRole = state.appUser.role || 'public';
  const userEmail = (state.appUser.email || '').toLowerCase();

  // Admin/oracle always have access
  if (['admin', 'oracle'].includes(userRole)) return true;

  if (visibility === 'public') return true;
  if (visibility === 'registered') return state.isAuthenticated;

  if (visibility.startsWith('role:')) {
    const requiredRole = visibility.split(':')[1];
    return (ROLE_LEVEL[userRole] || 0) >= (ROLE_LEVEL[requiredRole] || 0);
  }

  if (visibility === 'private') {
    // Check individual grants
    return grants.some(g => g.email.toLowerCase() === userEmail);
  }

  return false;
}

// ── Session Guard ──────────────────────────────────────────────────────
// The auth cache can show the toolbar even when the Supabase JWT is expired.
// Before any write operation, ensure we have a live session.
async function ensureSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return; // already have a valid session
  // Try refreshing — the refresh token may still be valid
  const { error } = await supabase.auth.refreshSession();
  if (error) {
    throw new Error('Session expired — please sign in again');
  }
}

// ── DB Operations ──────────────────────────────────────────────────────
async function fetchPageSettings(path) {
  const { data } = await supabase
    .from('page_access_settings')
    .select('page_path, visibility, updated_at')
    .eq('page_path', path)
    .maybeSingle();
  return data; // null if no row
}

async function fetchPageGrants(path) {
  const { data } = await supabase
    .from('page_access_grants')
    .select('email, granted_at')
    .eq('page_path', path);
  return data || [];
}

async function upsertVisibility(path, visibility) {
  await ensureSession();
  const { error } = await supabase
    .from('page_access_settings')
    .upsert({ page_path: path, visibility, updated_at: new Date().toISOString() }, { onConflict: 'page_path' });
  if (error) throw error;
}

async function addGrant(path, email, grantedBy) {
  await ensureSession();
  const { error } = await supabase
    .from('page_access_grants')
    .upsert({ page_path: path, email: email.toLowerCase(), granted_by: grantedBy }, { onConflict: 'page_path,email' });
  if (error) throw error;
}

async function removeGrant(path, email) {
  await ensureSession();
  const { error } = await supabase
    .from('page_access_grants')
    .delete()
    .eq('page_path', path)
    .eq('email', email.toLowerCase());
  if (error) throw error;
}

// ── Grant Access URL Param ─────────────────────────────────────────────
async function processGrantParam(state) {
  const params = new URLSearchParams(window.location.search);
  const grantEmail = params.get('grantaccess') || params.get('ga');
  if (!grantEmail) return;

  // Only admin/oracle can grant
  if (!['admin', 'oracle'].includes(state.appUser?.role)) return;

  try {
    await addGrant(pagePath, grantEmail, state.appUser.id);

    // If page has no settings row or is not private, auto-set to private
    if (!pageSettings || pageSettings.visibility !== 'private') {
      await upsertVisibility(pagePath, 'private');
      pageSettings = { page_path: pagePath, visibility: 'private' };
    }

    // Refresh grants
    pageGrants = await fetchPageGrants(pagePath);

    showToast(`Access granted to ${grantEmail}`, 'success');
  } catch (e) {
    console.error('[personal-page-shell] Grant failed:', e);
    showToast(`Failed to grant access: ${e.message}`, 'error');
  }

  // Strip param from URL
  params.delete('grantaccess');
  params.delete('ga');
  const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
  history.replaceState(null, '', cleanUrl);
}

// ── Owner Toolbar (Header Button + Dropdown Panel) ─────────────────────
function injectOwnerToolbar() {
  if (document.getElementById('ppSettingsBtn')) return;

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    @keyframes ppToastIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

    .pp-settings-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }

    #ppSettingsBtn {
      background: none; border: none; cursor: pointer;
      padding: 6px;
      display: flex; align-items: center; justify-content: center;
      opacity: 0.85; transition: opacity 0.15s;
    }
    #ppSettingsBtn:hover { opacity: 1; }

    #ppSettingsPanel {
      position: absolute; top: 100%; right: 0; z-index: 9991;
      width: 340px; max-height: 70vh; overflow-y: auto;
      background: #fff; border: 1px solid #e5e0d8; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      font-family: 'DM Sans', -apple-system, sans-serif;
      display: none; margin-top: 8px;
      color: #1c1618;
    }
    #ppSettingsPanel.open { display: block; }

    .pp-panel-header {
      padding: 0.75rem 1rem; border-bottom: 1px solid #e5e0d8;
      display: flex; align-items: center; justify-content: space-between;
    }
    .pp-panel-header h3 { font-size: 0.9rem; font-weight: 700; margin: 0; }
    .pp-panel-close { background: none; border: none; cursor: pointer; color: #8c8279; padding: 4px; }
    .pp-panel-close:hover { color: #1c1618; }

    .pp-panel-body { padding: 0.75rem 1rem; }
    .pp-panel-section { margin-bottom: 1rem; }
    .pp-panel-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #8c8279; margin-bottom: 0.4rem; }

    .pp-vis-list { display: flex; flex-direction: column; gap: 0.25rem; }
    .pp-vis-option {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.5rem 0.6rem; border-radius: 8px; cursor: pointer;
      border: 1px solid transparent; transition: all 0.12s;
      font-size: 0.85rem;
    }
    .pp-vis-option:hover { background: #faf9f6; }
    .pp-vis-option.active { background: #fef3e2; border-color: #d4883a; }
    .pp-vis-option .pp-vis-icon { flex-shrink: 0; }
    .pp-vis-option .pp-vis-text { flex: 1; }
    .pp-vis-option .pp-vis-name { font-weight: 600; }
    .pp-vis-option .pp-vis-desc { font-size: 0.75rem; color: #8c8279; }

    .pp-grants-list { display: flex; flex-direction: column; gap: 0.25rem; }
    .pp-grant-row {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.35rem 0.5rem; border-radius: 6px; font-size: 0.8rem;
      background: #faf9f6;
    }
    .pp-grant-email { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pp-grant-remove {
      background: none; border: none; cursor: pointer; color: #8c8279; padding: 2px;
      flex-shrink: 0;
    }
    .pp-grant-remove:hover { color: #ef4444; }

    .pp-add-grant {
      display: flex; gap: 0.4rem; margin-top: 0.5rem;
    }
    .pp-add-grant input {
      flex: 1; padding: 0.4rem 0.6rem; border: 1px solid #e5e0d8; border-radius: 6px;
      font-size: 0.8rem; font-family: inherit;
    }
    .pp-add-grant button {
      padding: 0.4rem 0.75rem; background: #d4883a; color: #fff; border: none;
      border-radius: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer;
      font-family: inherit;
    }
    .pp-add-grant button:hover { opacity: 0.9; }

    .pp-share-section { border-top: 1px solid #e5e0d8; padding-top: 0.75rem; margin-top: 0.5rem; }
    .pp-share-btn {
      display: flex; align-items: center; gap: 0.4rem;
      padding: 0.5rem 0.75rem; background: #faf9f6; border: 1px solid #e5e0d8;
      border-radius: 6px; cursor: pointer; font-size: 0.8rem; font-family: inherit;
      width: 100%; color: #1c1618;
    }
    .pp-share-btn:hover { background: #f0efea; }

    @media (max-width: 420px) {
      #ppSettingsPanel { right: -1rem; width: calc(100vw - 1rem); border-radius: 0 0 12px 12px; }
    }
  `;
  document.head.appendChild(style);

  // Create wrapper with button + dropdown
  const wrap = document.createElement('div');
  wrap.className = 'pp-settings-wrap';

  const btn = document.createElement('button');
  btn.id = 'ppSettingsBtn';
  btn.title = 'Page access settings';
  const vis = pageSettings?.visibility || 'registered';
  btn.innerHTML = getVisibilityIcon(vis);
  btn.style.color = VIS_COLORS[vis] || '#8c8279';
  wrap.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'ppSettingsPanel';
  wrap.appendChild(panel);

  // Insert into header: before #aapHeaderAuth or append to header inner
  const headerAuth = document.getElementById('aapHeaderAuth');
  if (headerAuth) {
    headerAuth.parentNode.insertBefore(wrap, headerAuth);
  } else {
    const headerInner = document.querySelector('.aap-header__inner');
    if (headerInner) {
      headerInner.appendChild(wrap);
    } else {
      // Fallback: append to body
      document.body.appendChild(wrap);
    }
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = panel.classList.contains('open');
    if (isOpen) {
      panel.classList.remove('open');
    } else {
      renderPanel();
      panel.classList.add('open');
    }
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) {
      panel.classList.remove('open');
    }
  });
}

function renderPanel() {
  const panel = document.getElementById('ppSettingsPanel');
  if (!panel) return;

  const currentVis = pageSettings?.visibility || 'registered';

  let grantsHtml = '';
  if (currentVis === 'private') {
    const grantRows = pageGrants.map(g => `
      <div class="pp-grant-row">
        <span class="pp-grant-email">${esc(g.email)}</span>
        <button class="pp-grant-remove" data-email="${esc(g.email)}" title="Remove">${ICONS.trash}</button>
      </div>
    `).join('') || '<div style="font-size:0.8rem;color:#8c8279;padding:0.25rem 0;">No individual grants yet</div>';

    grantsHtml = `
      <div class="pp-panel-section">
        <div class="pp-panel-label">Granted Access</div>
        <div class="pp-grants-list">${grantRows}</div>
        <div class="pp-add-grant">
          <input type="email" id="ppGrantEmail" placeholder="email@example.com">
          <button id="ppAddGrantBtn">Add</button>
        </div>
      </div>
    `;
  }

  panel.innerHTML = `
    <div class="pp-panel-header">
      <h3>Page Access</h3>
      <button class="pp-panel-close" id="ppPanelClose">${ICONS.x}</button>
    </div>
    <div class="pp-panel-body">
      <div class="pp-panel-section">
        <div class="pp-panel-label">Visibility</div>
        <div class="pp-vis-list">
          ${VISIBILITY_OPTIONS.map(opt => `
            <div class="pp-vis-option ${opt.value === currentVis ? 'active' : ''}" data-vis="${opt.value}">
              <span class="pp-vis-icon" style="color:${VIS_COLORS[opt.value] || '#8c8279'}">${ICONS[opt.icon]}</span>
              <div class="pp-vis-text">
                <div class="pp-vis-name">${opt.label}</div>
                <div class="pp-vis-desc">${opt.desc}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      ${grantsHtml}
      <div class="pp-share-section">
        <button class="pp-share-btn" id="ppCopyLinkBtn">
          ${ICONS.copy} Copy page link
        </button>
      </div>
    </div>
  `;

  // Bind close
  panel.querySelector('#ppPanelClose')?.addEventListener('click', () => panel.classList.remove('open'));

  // Bind visibility options
  panel.querySelectorAll('.pp-vis-option').forEach(el => {
    el.addEventListener('click', async () => {
      const newVis = el.dataset.vis;
      if (newVis === currentVis) return;
      try {
        await upsertVisibility(pagePath, newVis);
        pageSettings = { ...pageSettings, page_path: pagePath, visibility: newVis };
        if (newVis === 'private') {
          pageGrants = await fetchPageGrants(pagePath);
        }
        updateSettingsButtonIcon();
        renderPanel();
        showToast(`Visibility set to ${getVisibilityLabel(newVis)}`, 'success');
      } catch (e) {
        showToast(`Failed: ${e.message}`, 'error');
      }
    });
  });

  // Bind grant remove buttons
  panel.querySelectorAll('.pp-grant-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const email = btn.dataset.email;
      try {
        await removeGrant(pagePath, email);
        pageGrants = pageGrants.filter(g => g.email.toLowerCase() !== email.toLowerCase());
        renderPanel();
        showToast(`Removed ${email}`, 'success');
      } catch (e) {
        showToast(`Failed: ${e.message}`, 'error');
      }
    });
  });

  // Bind add grant
  panel.querySelector('#ppAddGrantBtn')?.addEventListener('click', async () => {
    const input = panel.querySelector('#ppGrantEmail');
    const email = input?.value?.trim();
    if (!email || !email.includes('@')) { showToast('Enter a valid email', 'error'); return; }
    try {
      await addGrant(pagePath, email, authState?.appUser?.id);
      pageGrants = await fetchPageGrants(pagePath);
      renderPanel();
      showToast(`Access granted to ${email}`, 'success');
      if (input) input.value = '';
    } catch (e) {
      showToast(`Failed: ${e.message}`, 'error');
    }
  });

  // Bind enter key on grant input
  panel.querySelector('#ppGrantEmail')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') panel.querySelector('#ppAddGrantBtn')?.click();
  });

  // Bind copy link
  panel.querySelector('#ppCopyLinkBtn')?.addEventListener('click', () => {
    const url = window.location.origin + pagePath;
    navigator.clipboard.writeText(url).then(() => {
      showToast('Link copied!', 'success', 2000);
    }).catch(() => {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('Link copied!', 'success', 2000);
    });
  });
}

// ── Header Injection ───────────────────────────────────────────────────
function injectHeader(options = {}) {
  // Ensure site.css is loaded (needed for header/avatar styling)
  if (!document.querySelector('link[href*="site.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/styles/site.css';
    document.head.appendChild(link);
  }

  let headerTarget = document.getElementById('siteHeader');
  if (!headerTarget) {
    headerTarget = document.createElement('div');
    headerTarget.id = 'siteHeader';
    document.body.prepend(headerTarget);
  }

  const versionEl = document.querySelector('[data-site-version]');
  const version = versionEl?.textContent?.trim() || '';

  headerTarget.innerHTML = renderHeader({
    transparent: false,
    light: false,
    activePage: '',
    showMistiq: false,
    version,
    ...options,
  });

  initSiteComponents();
  setupVersionInfo();
}

// ── User Menu in Header ────────────────────────────────────────────────
function renderUserMenu(state) {
  const authEl = document.getElementById('aapHeaderAuth');
  const signInLink = document.getElementById('aapSignInLink');
  const mobileSignInLink = document.getElementById('aapMobileSignInLink');

  if (!authEl || !state.appUser) return;

  const name = state.appUser.display_name || state.appUser.email;
  const initials = getInitials(name);
  const avatarUrl = state.appUser.avatar_url;
  const avatarHtml = avatarUrl
    ? `<img src="${avatarUrl}" alt="" class="user-avatar">`
    : `<span class="user-avatar user-avatar--initials">${initials}</span>`;

  const role = state.appUser.role || '';
  const isResident = ['admin', 'oracle', 'staff', 'resident', 'associate'].includes(role);
  let navLinks = '';
  if (isResident) {
    navLinks += `<a href="/spaces/admin/rentals.html" class="user-menu-item">Intranet</a>`;
  }

  authEl.innerHTML = `
    <button class="user-menu-trigger" aria-haspopup="true" aria-expanded="false">
      ${avatarHtml}<span class="user-profile-name">${esc(name)}</span>
    </button>
    <div class="user-menu-dropdown hidden">
      <a href="/residents/profile.html" class="user-menu-item">Profile</a>
      ${navLinks}
      <button class="user-menu-item user-menu-signout" id="ppSignOutBtn">Sign Out</button>
    </div>`;
  authEl.classList.add('user-info');

  if (signInLink) signInLink.style.display = 'none';
  if (mobileSignInLink) mobileSignInLink.closest('li')?.remove();

  // Dropdown toggle
  const trigger = authEl.querySelector('.user-menu-trigger');
  const dropdown = authEl.querySelector('.user-menu-dropdown');
  if (trigger && dropdown) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !dropdown.classList.contains('hidden');
      dropdown.classList.toggle('hidden', open);
      trigger.setAttribute('aria-expanded', !open);
    });
    document.addEventListener('click', () => {
      dropdown.classList.add('hidden');
      trigger.setAttribute('aria-expanded', 'false');
    });
  }

  // Sign out
  authEl.querySelector('#ppSignOutBtn')?.addEventListener('click', async () => {
    await signOut();
    window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
  });
}

function getInitials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (name[0] || '?').toUpperCase();
}

// ── Access Denied Overlay ──────────────────────────────────────────────
function renderAccessDenied(state) {
  let overlay = document.getElementById('ppAccessDenied');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'ppAccessDenied';
    overlay.style.cssText = 'position:fixed;inset:0;background:#faf9f6;display:flex;align-items:center;justify-content:center;z-index:9998;font-family:"DM Sans",-apple-system,sans-serif;';
    document.body.appendChild(overlay);
  }

  const name = state.appUser?.display_name || state.appUser?.email || state.user?.email || 'Unknown';

  overlay.innerHTML = `
    <div style="background:#fff;border:1px solid #e5e0d8;border-radius:12px;padding:2rem;max-width:380px;width:90%;text-align:center;">
      <h2 style="font-size:1.1rem;margin-bottom:0.5rem;">Access Restricted</h2>
      <p style="font-size:0.85rem;color:#8c8279;margin-bottom:0.75rem;">
        Signed in as <strong>${esc(name)}</strong>
      </p>
      <p style="font-size:0.85rem;color:#1c1618;margin-bottom:1.25rem;">
        You don't have access to this page. The page owner may need to grant you access.
      </p>
      <div style="display:flex;gap:0.5rem;justify-content:center;">
        <a href="/" style="padding:0.5rem 1rem;background:#faf9f6;border:1px solid #e5e0d8;border-radius:8px;text-decoration:none;color:#1c1618;font-size:0.85rem;font-weight:600;">Home</a>
        <button id="ppDeniedSignOut" style="padding:0.5rem 1rem;background:#d4883a;color:#fff;border:none;border-radius:8px;font-size:0.85rem;font-weight:600;cursor:pointer;">Sign Out</button>
      </div>
    </div>
  `;

  overlay.querySelector('#ppDeniedSignOut')?.addEventListener('click', async () => {
    await signOut();
    window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
  });
}

function removeAccessDenied() {
  document.getElementById('ppAccessDenied')?.remove();
}

// ── Main Entry Point ───────────────────────────────────────────────────

/**
 * Initialize a personal page with auth gate, header, and privacy controls.
 * @param {Object} options
 * @param {boolean} options.transparent - Header transparent mode
 * @param {boolean} options.light - Header light/dark mode
 * @param {Function} options.onReady - Called with authState when access is confirmed
 * @returns {Promise<Object>} authState
 */
export async function initPersonalPage(options = {}) {
  pagePath = getPagePath();

  // Step 1: Inject header immediately
  injectHeader(options);

  // Step 2: Fetch page access settings (doesn't require auth)
  try {
    pageSettings = await fetchPageSettings(pagePath);
  } catch (e) {
    console.warn('[personal-page-shell] Failed to fetch page settings, defaulting to registered:', e);
    pageSettings = null;
  }

  const visibility = pageSettings?.visibility || 'registered';

  // Step 3: If public, no auth needed
  if (visibility === 'public') {
    initPublicHeaderAuth({
      authContainerId: 'aapHeaderAuth',
      signInLinkId: 'aapSignInLink',
    });
    // Still check if user is admin for toolbar
    try {
      await initAuth();
      authState = getAuthState();
      if (authState.isAdmin) {
        isOwner = true;
        injectOwnerToolbar();
      }
    } catch (e) { /* ignore */ }
    if (options.onReady) options.onReady(authState || getAuthState());
    return authState || getAuthState();
  }

  // Step 4: Auth required — init auth
  await initAuth();
  authState = getAuthState();

  // Not authenticated -> redirect to login
  if (!authState.isAuthenticated) {
    window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
    return authState;
  }

  // Render user menu in header
  renderUserMenu(authState);

  // Step 5: Fetch grants if private
  if (visibility === 'private') {
    try {
      pageGrants = await fetchPageGrants(pagePath);
    } catch (e) {
      console.warn('[personal-page-shell] Failed to fetch grants:', e);
    }
  }

  // Step 6: Check if user is admin/oracle (owner)
  isOwner = ['admin', 'oracle'].includes(authState.appUser?.role);

  // Step 7: Process ?grantaccess= / ?ga= param
  await processGrantParam(authState);

  // Step 8: Check access
  const hasAccess = checkAccess(authState, pageSettings, pageGrants);

  if (hasAccess) {
    removeAccessDenied();
    if (isOwner) injectOwnerToolbar();
    if (options.onReady) options.onReady(authState);
  } else {
    renderAccessDenied(authState);
  }

  // Listen for auth state changes (token refresh, etc.)
  onAuthStateChange((newState) => {
    authState = newState;
    if (!newState.isAuthenticated) {
      window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
    }
  });

  return authState;
}

// Make available globally for non-module scripts
if (typeof window !== 'undefined') {
  window.aapPersonalPage = { initPersonalPage };
}
