/**
 * Glowforge Data Service
 * Loads Glowforge laser cutter data from Supabase and fetches live status via edge function.
 * No DOM code — just data fetching and display helpers.
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabase.js';

const GLOWFORGE_CONTROL_URL = `${SUPABASE_URL}/functions/v1/glowforge-control`;

// =============================================
// API WRAPPER
// =============================================

async function glowforgeApi(action, params = {}) {
  let { data: { session } } = await supabase.auth.getSession();
  if (session) {
    const expiresAt = session.expires_at;
    const now = Math.floor(Date.now() / 1000);
    if (!expiresAt || expiresAt - now < 60) {
      const { data } = await supabase.auth.refreshSession();
      session = data.session;
    }
  } else {
    const { data } = await supabase.auth.refreshSession();
    session = data.session;
  }
  const token = session?.access_token;
  if (!token) throw new Error('No auth token');

  const response = await fetch(GLOWFORGE_CONTROL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action, ...params }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `API error ${response.status}`);
  }
  return response.json();
}

// =============================================
// DATA LOADING
// =============================================

export async function loadGlowforgeMachines() {
  const { data, error } = await supabase
    .from('glowforge_machines')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) throw error;
  return data || [];
}

// =============================================
// COMMANDS (via edge function → Glowforge Cloud API)
// =============================================

export async function refreshGlowforgeStatus() {
  return glowforgeApi('getStatus');
}

// =============================================
// DISPLAY HELPERS
// =============================================

/**
 * Get display state from a Glowforge machine record.
 * States from the API: "online", "unavailable", "offline"
 */
export function getMachineStateDisplay(machine) {
  const s = machine.last_state;
  if (!s) return { text: 'No data', color: 'var(--text-muted)', isOnline: false };

  // The API returns a state field — try various known property names
  const state = s.state || s.status || s.machine_state || null;

  if (state === 'online') {
    return { text: 'Online', color: 'var(--available)', isOnline: true };
  }
  if (state === 'unavailable') {
    return { text: 'Unavailable', color: '#f59e0b', isOnline: false };
  }
  if (state === 'offline') {
    return { text: 'Offline', color: 'var(--text-muted)', isOnline: false };
  }

  // If no recognized state, check if the machine has any activity data
  if (s.last_bed_image_at || s.last_print_at) {
    return { text: 'Unknown', color: 'var(--text-muted)', isOnline: false };
  }

  return { text: state || 'Unknown', color: 'var(--text-muted)', isOnline: false };
}

/**
 * Format the last activity timestamp (bed camera or print).
 */
export function getLastActivity(machine) {
  const s = machine.last_state;
  if (!s) return null;

  const lastBed = s.last_bed_image_at || s.lastBedImageAt || null;
  const lastPrint = s.last_print_at || s.lastPrintAt || null;

  // Use whichever is more recent
  const timestamps = [lastBed, lastPrint].filter(Boolean).map(t => new Date(t).getTime());
  if (timestamps.length === 0) return null;

  const mostRecent = new Date(Math.max(...timestamps));
  return formatRelativeTime(mostRecent);
}

/**
 * Get the machine model/type for display.
 */
export function getMachineModel(machine) {
  return machine.machine_type || machine.last_state?.type || machine.last_state?.model || null;
}

function formatRelativeTime(date) {
  const diff = Date.now() - date.getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.round(diff / 86400000)}d ago`;
  return date.toLocaleDateString();
}

export function formatSyncTime(lastSyncedAt) {
  if (!lastSyncedAt) return 'Never synced';
  const diff = Date.now() - new Date(lastSyncedAt).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return new Date(lastSyncedAt).toLocaleDateString();
}
