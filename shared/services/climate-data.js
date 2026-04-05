/**
 * Climate Data Service
 * Loads Nest thermostat data and sends control commands via edge function.
 * Includes resident-level filtering: residents see only their assigned room's thermostat.
 * No DOM code — just data fetching and thermostat control.
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabase.js';

const NEST_CONTROL_URL = `${SUPABASE_URL}/functions/v1/nest-control`;

// =============================================
// API WRAPPER
// =============================================

async function nestApi(action, params = {}) {
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

  const response = await fetch(NEST_CONTROL_URL, {
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

/**
 * Load thermostats from nest_devices, filtered by role + resident assignment.
 *
 * Role-based filtering:
 *  - admin/staff: see all active thermostats (except min_role='admin' for staff)
 *  - resident/associate: only see thermostats whose space_id matches their
 *    assignment_spaces (via people.email → app_users.email → active assignments)
 *    AND min_role is null or 'resident'
 *
 * @param {{role: string, email: string, id: string}} appUser
 * @returns {Promise<Array<{id, sdmDeviceId, roomName, displayOrder, lanIp, state, spaceId, minRole}>>}
 */
export async function loadThermostats(appUser) {
  const { data, error } = await supabase
    .from('nest_devices')
    .select('*')
    .eq('is_active', true)
    .eq('device_type', 'thermostat')
    .order('display_order', { ascending: true });

  if (error) throw error;

  let devices = (data || []).map(d => ({
    id: d.id,
    sdmDeviceId: d.sdm_device_id,
    roomName: d.room_name,
    displayOrder: d.display_order,
    lanIp: d.lan_ip,
    state: d.last_state || null,
    spaceId: d.space_id,
    minRole: d.min_role,
  }));

  const role = appUser?.role;
  const ROLE_LEVEL = { admin: 3, staff: 2, resident: 1, associate: 1 };
  const userLevel = ROLE_LEVEL[role] || 0;

  if (userLevel >= 2) {
    // Staff+ see all thermostats they have the role level for
    devices = devices.filter(d => {
      if (!d.minRole) return true;
      const requiredLevel = ROLE_LEVEL[d.minRole] || 0;
      return userLevel >= requiredLevel;
    });
  } else {
    // Resident/associate: filter by assignment space
    const allowedSpaceIds = await getResidentSpaceIds(appUser.email);
    devices = devices.filter(d => {
      // Must not require higher role
      if (d.minRole && (ROLE_LEVEL[d.minRole] || 0) > userLevel) return false;
      // Must match assigned space (or have no space_id set — show to all)
      if (!d.spaceId) return false;
      return allowedSpaceIds.includes(d.spaceId);
    });
  }

  return devices;
}

/**
 * Get space IDs the resident is assigned to via active assignments.
 * Chain: app_users.email → people.email → assignments (active) → assignment_spaces.space_id
 */
async function getResidentSpaceIds(email) {
  if (!email) return [];

  // Find person by email
  const { data: people } = await supabase
    .from('people')
    .select('id')
    .eq('email', email)
    .limit(1);

  if (!people?.length) return [];
  const personId = people[0].id;

  // Find active assignments for this person
  const { data: assignments } = await supabase
    .from('assignments')
    .select('id, assignment_spaces(space_id)')
    .eq('person_id', personId)
    .in('status', ['active', 'pending_contract', 'contract_sent']);

  if (!assignments?.length) return [];

  const spaceIds = [];
  for (const a of assignments) {
    for (const as of (a.assignment_spaces || [])) {
      if (as.space_id) spaceIds.push(as.space_id);
    }
  }
  return [...new Set(spaceIds)];
}

/**
 * Refresh all thermostat states from the SDM API (via edge function).
 * Returns updated state map keyed by sdmDeviceId.
 * @param {Array} thermostats - Array of thermostat objects
 * @returns {Promise<Object>} Map of { sdmDeviceId: state }
 */
export async function refreshAllStates(thermostats) {
  if (!thermostats.length) return {};

  const result = await nestApi('getAllStates');
  const stateMap = {};

  if (result.devices) {
    for (const device of result.devices) {
      if (device.error) continue;
      if (device.state) {
        stateMap[device.deviceId] = device.state;
      }
    }
  }
  return stateMap;
}

/**
 * Set thermostat temperature.
 * @param {string} sdmDeviceId
 * @param {Object} state - Current thermostat state
 * @param {'up'|'down'} direction
 */
export async function setTemperature(sdmDeviceId, state, direction) {
  if (!state || state.mode === 'OFF') return;

  const delta = direction === 'up' ? 1 : -1;

  if (state.mode === 'HEATCOOL') {
    await nestApi('setTemperature', {
      deviceId: sdmDeviceId,
      heatTemp: state.heatSetpointF + delta,
      coolTemp: state.coolSetpointF + delta,
    });
  } else if (state.mode === 'COOL') {
    await nestApi('setTemperature', {
      deviceId: sdmDeviceId,
      temperature: state.coolSetpointF + delta,
    });
  } else {
    await nestApi('setTemperature', {
      deviceId: sdmDeviceId,
      temperature: state.heatSetpointF + delta,
    });
  }
}

/**
 * Set thermostat mode.
 * @param {string} sdmDeviceId
 * @param {'HEAT'|'COOL'|'HEATCOOL'|'OFF'} mode
 */
export async function setMode(sdmDeviceId, mode) {
  await nestApi('setMode', { deviceId: sdmDeviceId, mode });
}

/**
 * Toggle eco mode.
 * @param {string} sdmDeviceId
 * @param {string} currentEcoMode - Current eco mode
 */
export async function toggleEco(sdmDeviceId, currentEcoMode) {
  const newEco = currentEcoMode === 'MANUAL_ECO' ? 'OFF' : 'MANUAL_ECO';
  await nestApi('setEco', { deviceId: sdmDeviceId, ecoMode: newEco });
}

/**
 * Format mode for display.
 */
export function formatMode(mode) {
  const labels = { HEAT: 'Heat', COOL: 'Cool', HEATCOOL: 'Heat/Cool', OFF: 'Off' };
  return labels[mode] || mode;
}
