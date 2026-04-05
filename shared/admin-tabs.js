/**
 * Admin Tab Definitions - Shared tab config for staff/admin sections.
 * Extracted to avoid circular dependencies between admin-shell.js and context-switcher.js.
 */

export const ALL_ADMIN_TABS = [
  // Staff section
  { id: 'spaces', label: 'Spaces', href: 'spaces.html', permission: 'view_spaces', section: 'staff' },
  { id: 'rentals', label: 'Rentals', href: 'rentals.html', permission: 'view_rentals', section: 'staff', feature: 'rentals' },
  { id: 'reservations', label: 'Reservations', href: 'reservations.html', permission: 'view_rentals', section: 'staff', feature: 'rentals' },
  { id: 'events', label: 'Events', href: 'events.html', permission: 'view_events', section: 'staff', feature: 'events' },
  { id: 'media', label: 'Media', href: 'media.html', permission: 'view_media', section: 'staff' },
  { id: 'sms', label: 'SMS', href: 'sms-messages.html', permission: 'view_sms', section: 'staff', feature: 'sms' },
  { id: 'purchases', label: 'Purchases', href: 'purchases.html', permission: 'view_purchases', section: 'staff' },
  { id: 'hours', label: 'Workstuff', href: 'worktracking.html', permission: 'view_hours', section: 'staff', feature: 'associates' },
  { id: 'faq', label: 'FAQ/AI', href: 'faq.html', permission: 'view_faq', section: 'staff', feature: 'pai' },
  { id: 'voice', label: 'Concierge', href: 'voice.html', permission: 'view_voice', section: 'staff', feature: 'voice' },
  { id: 'todo', label: 'Todo', href: 'devcontrol/#planlist', permission: 'view_todo', section: 'staff' },
  { id: 'phyprop', label: 'PhyProp', href: 'phyprop.html', permission: 'view_spaces', section: 'staff' },
  { id: 'inventory', label: 'Inventory', href: 'inventory.html', permission: 'view_inventory', section: 'staff' },
  { id: 'appdev', label: 'App Dev', href: 'appdev.html', permission: 'view_appdev', section: 'staff' },
  // Admin section
  { id: 'users', label: 'Users', href: 'users.html', permission: 'view_users', section: 'admin' },
  { id: 'passwords', label: 'Passwords', href: 'passwords.html', permission: 'view_passwords', section: 'admin' },
  { id: 'settings', label: 'Settings', href: 'settings.html', permission: 'view_settings', section: 'admin' },
  { id: 'releases', label: 'Releases', href: 'releases.html', permission: 'view_settings', section: 'admin' },
  { id: 'templates', label: 'Templates', href: 'templates.html', permission: 'view_templates', section: 'admin', feature: 'documents' },
  { id: 'brand', label: 'Brand', href: 'brand.html', permission: 'view_settings', section: 'admin' },
  { id: 'accounting', label: 'Accounting', href: 'accounting.html', permission: 'view_accounting', section: 'admin' },
  { id: 'notifications', label: 'Notifications', href: 'notifications.html', permission: 'view_settings', section: 'admin' },
  { id: 'testdev', label: 'Test Dev', href: 'testdev.html', permission: 'view_settings', section: 'admin' },
  { id: 'lifeofpai', label: 'Life of PAI', href: '/residents/lifeofpaiadmin.html', permission: 'admin_pai_settings', section: 'admin', feature: 'pai' },
  { id: 'openclaw', label: 'AlpaClaw', href: 'alpaclaw.html', permission: 'view_openclaw', section: 'admin', feature: 'pai' },
  // DevControl is a top-level nav item (in context switcher), not an admin sub-tab — but listed here for permission sync
  { id: 'devcontrol', label: 'DevControl', href: '/spaces/admin/devcontrol/', permission: 'view_devcontrol', section: 'admin' },
];
