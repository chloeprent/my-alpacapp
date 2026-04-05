/**
 * Context Switcher - Shared module for the intranet navigation bar
 * (Devices / Residents / Associates / Staff / Admin / DevControl)
 *
 * Single source of truth for permission keys and context-switcher rendering.
 * Imported by admin-shell.js, resident-shell.js, and associate-shell.js.
 */

import { hasAnyPermission, hasPermission } from './auth.js';
import { getEnabledFeatures } from './feature-registry.js';
import { ALL_ADMIN_TABS } from './admin-tabs.js';

// =============================================
// CANONICAL PERMISSION KEY LISTS
// =============================================
export const STAFF_PERMISSION_KEYS = [
  'view_spaces', 'view_rentals', 'view_events', 'view_media', 'view_sms',
  'view_purchases', 'view_hours', 'view_faq', 'view_voice', 'view_todo',
  'view_appdev', 'view_inventory',
];

export const ADMIN_PERMISSION_KEYS = [
  'view_users', 'view_passwords', 'view_settings', 'view_templates',
  'view_accounting', 'view_testdev', 'view_openclaw', 'view_devcontrol',
  'admin_pai_settings',
];

export const DEVICE_PERMISSION_KEYS = [
  'view_lighting', 'view_music', 'view_cameras', 'view_climate',
  'view_laundry', 'view_cars', 'view_oven', 'view_glowforge', 'view_printer',
];

// =============================================
// CONTEXT SWITCHER RENDERING
// =============================================

/**
 * Render the context switcher bar.
 * @param {Object} opts
 * @param {string} opts.activeSection - One of: 'devices', 'resident', 'associate', 'staff', 'admin', 'devcontrol'
 * @param {string} [opts.userRole] - The user's role (e.g. 'admin', 'staff', 'associate', 'resident')
 */
export async function renderContextSwitcher({ activeSection = 'resident', userRole = '' } = {}) {
  const switcher = document.getElementById('contextSwitcher');
  if (!switcher) return;

  const hasStaffPerms = hasAnyPermission(...STAFF_PERMISSION_KEYS);
  const hasAdminPerms = hasAnyPermission(...ADMIN_PERMISSION_KEYS);
  const hasDevicePerms = hasAnyPermission(...DEVICE_PERMISSION_KEYS);
  const hasAssociatePerms = hasAnyPermission('clock_in_out', 'view_own_hours');
  const hasDevControlPerm = hasPermission('view_devcontrol');

  // If user has no elevated perms at all, hide the switcher
  if (!hasStaffPerms && !hasAdminPerms && !hasDevicePerms && !hasAssociatePerms) {
    switcher.classList.add('hidden');
    return;
  }

  // Resolve Staff/Admin hrefs to first accessible tab (feature-flag aware)
  const enabledFeatures = await getEnabledFeatures();
  const firstStaffTab = ALL_ADMIN_TABS.find(t =>
    t.section === 'staff' && (!t.feature || enabledFeatures[t.feature]) && hasAnyPermission(t.permission)
  );
  const firstAdminTab = ALL_ADMIN_TABS.find(t =>
    t.section === 'admin' && (!t.feature || enabledFeatures[t.feature]) && hasAnyPermission(t.permission)
  );
  const staffHref = firstStaffTab
    ? (firstStaffTab.href.startsWith('/') ? firstStaffTab.href : `/spaces/admin/${firstStaffTab.href}`)
    : '/spaces/admin/';
  const adminHref = firstAdminTab
    ? (firstAdminTab.href.startsWith('/') ? firstAdminTab.href : `/spaces/admin/${firstAdminTab.href}`)
    : '/spaces/admin/users.html';

  // Build tabs — only show tabs the user has access to
  const tabs = [];
  if (hasDevicePerms) tabs.push({ id: 'devices', label: 'Devices', href: '/residents/devices.html' });
  tabs.push({ id: 'resident', label: 'Residents', href: '/residents/' });
  if (hasAssociatePerms || ['staff', 'admin', 'oracle'].includes(userRole)) {
    tabs.push({ id: 'associate', label: 'Associates', href: '/associates/worktracking.html' });
  }
  if (hasStaffPerms) tabs.push({ id: 'staff', label: 'Staff', href: staffHref });
  if (hasAdminPerms) tabs.push({ id: 'admin', label: 'Admin', href: adminHref });
  if (hasDevControlPerm) tabs.push({ id: 'devcontrol', label: 'DevControl', href: '/spaces/admin/devcontrol/' });

  // Hide if only one tab (nothing to switch between)
  if (tabs.length <= 1) {
    switcher.classList.add('hidden');
    return;
  }

  // Resolve active section — fall back to safe defaults
  let resolved = activeSection;
  if (resolved === 'devcontrol' && !hasDevControlPerm) resolved = 'staff';
  if (resolved === 'admin' && !hasAdminPerms) resolved = 'staff';
  if (resolved === 'staff' && !hasStaffPerms) resolved = 'resident';

  switcher.innerHTML = tabs.map(tab => {
    const isActive = tab.id === resolved;
    const activeClass = isActive ? ' active' : '';
    return `<a href="${tab.href}" class="context-switcher-btn${activeClass}">${tab.label}</a>`;
  }).join('');

  switcher.classList.remove('hidden');
}
