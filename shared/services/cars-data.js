/**
 * Cars Data Service
 * Loads Tesla vehicle data from Supabase and sends commands via edge function.
 * No DOM code — just data fetching and vehicle commands.
 */

import { supabase } from '../supabase.js';

/**
 * Load active vehicles from vehicles table.
 * @returns {Promise<Array>}
 */
export async function loadVehicles() {
  const { data, error } = await supabase
    .from('vehicles')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) {
    console.warn('Failed to load vehicles:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Load Tesla accounts (for admin settings).
 * @returns {Promise<Array>}
 */
export async function loadAccounts() {
  const { data, error } = await supabase
    .from('tesla_accounts')
    .select('id, owner_name, tesla_email, is_active, last_error, refresh_token, updated_at, app_user_id')
    .order('id', { ascending: true });

  if (error) {
    console.warn('Failed to load accounts:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Check if the current user has a linked Tesla account.
 * @param {string} appUserId - Current user's app_users.id
 * @returns {Promise<boolean>}
 */
export async function userHasTeslaAccount(appUserId) {
  if (!appUserId) return false;
  const { data, error } = await supabase
    .from('tesla_accounts')
    .select('id')
    .eq('app_user_id', appUserId)
    .eq('is_active', true)
    .limit(1);
  if (error) return false;
  return (data?.length || 0) > 0;
}

/**
 * Send a command to a Tesla vehicle via edge function.
 * @param {number} vehicleId - vehicles.id
 * @param {string} command - door_lock, door_unlock, flash_lights, honk_horn
 * @returns {Promise<{vehicle_name?: string, error?: string}>}
 */
export async function sendCommand(vehicleId, command) {
  const { data, error } = await supabase.functions.invoke('tesla-command', {
    body: { vehicle_id: vehicleId, command },
  });

  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Format sync time as relative string.
 * @param {string|null} lastSyncedAt - ISO timestamp
 * @returns {string}
 */
export function formatSyncTime(lastSyncedAt) {
  if (!lastSyncedAt) return 'Never synced';
  const diff = Date.now() - new Date(lastSyncedAt).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return new Date(lastSyncedAt).toLocaleDateString();
}

/**
 * Get status display for a vehicle.
 * @param {{vehicle_state: string, last_state: Object}} car
 * @returns {{text: string, color: string}}
 */
export function getStatusDisplay(car) {
  const s = car.last_state;
  if (car.vehicle_state === 'asleep') return { text: 'Asleep', color: '#888' };
  if (car.vehicle_state === 'offline') return { text: 'Offline', color: '#e74c3c' };
  if (!s) return { text: '--', color: '#888' };
  if (s.charging_state === 'Charging') return { text: 'Charging', color: '#27ae60' };
  if (s.charging_state === 'Complete') return { text: 'Charge Complete', color: '#27ae60' };
  return { text: 'Online', color: '#27ae60' };
}

/**
 * Get formatted data rows for a vehicle card.
 * @param {{vehicle_state: string, last_state: Object}} car
 * @returns {Array<{label: string, icon: string, value: string}>}
 */
export function getDataRows(car) {
  const s = car.last_state;
  if (!s) {
    return [
      { label: 'Battery', icon: 'battery', value: '--' },
      { label: 'Status', icon: 'status', value: car.vehicle_state === 'unknown' ? 'Not connected' : car.vehicle_state },
      { label: 'Locked', icon: 'lock', value: '--' },
    ];
  }

  const status = getStatusDisplay(car);
  const batteryStr = s.battery_level != null
    ? `${s.battery_level}%${s.battery_range_mi != null ? ` \u00b7 ${Math.round(s.battery_range_mi)} mi` : ''}`
    : '--';
  const lockStr = s.locked === true ? 'Locked' : s.locked === false ? 'Unlocked' : '--';

  return [
    { label: 'Battery', icon: 'battery', value: batteryStr },
    { label: 'Status', icon: 'status', value: status.text, color: status.color },
    { label: 'Locked', icon: 'lock', value: lockStr },
  ];
}
