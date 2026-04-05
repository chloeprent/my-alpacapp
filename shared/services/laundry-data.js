/**
 * Laundry Data Service
 * Loads LG washer/dryer data from Supabase and manages watch subscriptions.
 * No DOM code — just data fetching and commands.
 */

import { supabase } from '../supabase.js';

/**
 * Load active appliances from lg_appliances table.
 * @returns {Promise<Array>}
 */
export async function loadAppliances() {
  const { data, error } = await supabase
    .from('lg_appliances')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) {
    console.warn('Failed to load appliances:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Load watcher status for a user (which appliances they're watching).
 * @param {string} appUserId
 * @returns {Promise<Set<number>>} Set of appliance IDs being watched
 */
export async function loadWatcherStatus(appUserId) {
  if (!appUserId) return new Set();
  const { data, error } = await supabase
    .from('laundry_watchers')
    .select('appliance_id')
    .eq('app_user_id', appUserId);

  if (error) {
    console.warn('Failed to load watcher status:', error.message);
    return new Set();
  }
  return new Set((data || []).map(w => w.appliance_id));
}

/**
 * Toggle watch subscription for an appliance.
 * @param {number} applianceId
 * @param {boolean} watch - true to watch, false to unwatch
 * @returns {Promise<{watching: boolean}>}
 */
export async function toggleWatch(applianceId, watch) {
  const { data, error } = await supabase.functions.invoke('lg-control', {
    body: { action: watch ? 'watch' : 'unwatch', applianceId },
  });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Send a control command to an appliance.
 * @param {number} applianceId
 * @param {string} command - e.g. "START", "STOP", "POWER_OFF"
 * @returns {Promise<Object>}
 */
export async function sendControl(applianceId, command) {
  const { data, error } = await supabase.functions.invoke('lg-control', {
    body: { action: 'control', applianceId, command },
  });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Format sync time as relative string.
 * @param {string|null} lastSyncedAt
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
 * Format time remaining as readable string.
 * @param {number|null} hours
 * @param {number|null} minutes
 * @returns {string}
 */
export function formatTimeRemaining(hours, minutes) {
  if (hours == null && minutes == null) return '';
  const h = hours || 0;
  const m = minutes || 0;
  if (h === 0 && m === 0) return '';
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// States that indicate the machine is actively running
const RUNNING_STATES = new Set([
  'RUNNING', 'RINSING', 'SPINNING', 'DRYING',
  'STEAM_SOFTENING', 'COOL_DOWN', 'DETECTING',
  'REFRESHING', 'RINSE_HOLD',
]);

/**
 * Get display properties for an appliance state.
 * @param {Object} appliance
 * @returns {{text: string, color: string, isRunning: boolean, isDone: boolean}}
 */
export function getStateDisplay(appliance) {
  const s = appliance.last_state || {};
  const state = s.currentState || 'POWER_OFF';

  if (state === 'POWER_OFF' || state === 'SLEEP') {
    return { text: 'Off', color: 'var(--text-muted)', isRunning: false, isDone: false };
  }
  if (state === 'END') {
    return { text: 'Done!', color: '#f59e0b', isRunning: false, isDone: true };
  }
  if (state === 'PAUSE') {
    return { text: 'Paused', color: '#f59e0b', isRunning: false, isDone: false };
  }
  if (state === 'ERROR') {
    return { text: 'Error', color: 'var(--occupied)', isRunning: false, isDone: false };
  }
  if (state === 'RESERVED') {
    return { text: 'Scheduled', color: '#8b5cf6', isRunning: false, isDone: false };
  }
  if (state === 'INITIAL' || state === 'DETECTING') {
    return { text: 'Starting...', color: 'var(--available)', isRunning: true, isDone: false };
  }

  // Active running states
  if (RUNNING_STATES.has(state)) {
    const deviceType = appliance.device_type || s.deviceType;
    if (state === 'RINSING') return { text: 'Rinsing', color: 'var(--available)', isRunning: true, isDone: false };
    if (state === 'SPINNING') return { text: 'Spinning', color: 'var(--available)', isRunning: true, isDone: false };
    if (state === 'DRYING') return { text: 'Drying', color: 'var(--available)', isRunning: true, isDone: false };
    if (state === 'STEAM_SOFTENING') return { text: 'Steam Softening', color: 'var(--available)', isRunning: true, isDone: false };
    if (state === 'COOL_DOWN') return { text: 'Cooling Down', color: 'var(--available)', isRunning: true, isDone: false };
    const label = deviceType === 'dryer' ? 'Drying' : 'Washing';
    return { text: `${label}...`, color: 'var(--available)', isRunning: true, isDone: false };
  }

  return { text: state, color: 'var(--text-muted)', isRunning: false, isDone: false };
}

/**
 * Calculate progress percentage from total and remaining time.
 * @param {Object} state - last_state object
 * @returns {number} 0-100
 */
export function getProgressPercent(state) {
  if (!state) return 0;
  const totalMin = (state.totalHour || 0) * 60 + (state.totalMinute || 0);
  const remainMin = (state.remainHour || 0) * 60 + (state.remainMinute || 0);
  if (totalMin <= 0) return 0;
  const elapsed = totalMin - remainMin;
  return Math.max(0, Math.min(100, Math.round((elapsed / totalMin) * 100)));
}
