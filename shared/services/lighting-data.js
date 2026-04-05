/**
 * Lighting Data Service
 * Loads Govee device groups from DB, sends control commands via edge function.
 * No DOM code — just data fetching, state management, and control functions.
 */

import { supabase, SUPABASE_ANON_KEY } from '../supabase.js';

const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const GOVEE_CONTROL_URL = `${SUPABASE_URL}/functions/v1/govee-control`;

// Color presets for quick selection
export const COLOR_PRESETS = [
  { name: 'Warm White', hex: '#FFD4A3', temp: 3000 },
  { name: 'Cool White', hex: '#E8F0FF', temp: 5500 },
  { name: 'Red', hex: '#FF0000' },
  { name: 'Orange', hex: '#FF6600' },
  { name: 'Purple', hex: '#8800FF' },
  { name: 'Blue', hex: '#0044FF' },
  { name: 'Green', hex: '#00CC00' },
  { name: 'Pink', hex: '#FF69B4' },
];

const AREA_ORDER = ['Spartan', 'Garage Mahal', 'Outhouse', 'Bedrooms'];

// =============================================
// API WRAPPER
// =============================================

export async function goveeApi(action, params = {}) {
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

  const response = await fetch(GOVEE_CONTROL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action, ...params }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || err.message || `API error ${response.status}`);
  }
  return response.json();
}

// =============================================
// DATA LOADING
// =============================================

/**
 * Load lighting groups from DB, with children, models, and area grouping.
 * @returns {Promise<{groups: Array, sections: Array}>}
 *   groups: flat list of group objects
 *   sections: area-grouped sections [{name, sectionId, groups[]}]
 */
export async function loadGroupsFromDB() {
  const { data: groups, error: groupErr } = await supabase
    .from('govee_devices')
    .select('device_id, name, area, display_order')
    .eq('is_group', true)
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (groupErr) throw groupErr;

  const { data: children, error: childErr } = await supabase
    .from('govee_devices')
    .select('device_id, name, sku, parent_group_id, capabilities')
    .eq('is_group', false)
    .eq('is_active', true)
    .not('parent_group_id', 'is', null)
    .order('name', { ascending: true });

  if (childErr) throw childErr;

  const { data: models, error: modelErr } = await supabase
    .from('govee_models')
    .select('sku, model_name, segment_count');

  if (modelErr) throw modelErr;

  const modelMap = {};
  const segmentCountMap = {};
  for (const m of models) {
    modelMap[m.sku] = m.model_name;
    if (m.segment_count) segmentCountMap[m.sku] = m.segment_count;
  }

  const goveeGroups = groups.map(g => {
    const groupChildren = children.filter(c => c.parent_group_id === g.device_id);
    const uniqueModels = [...new Set(groupChildren.map(c => modelMap[c.sku]).filter(Boolean))];

    return {
      name: g.name,
      groupId: g.device_id,
      area: g.area || 'Other',
      deviceCount: groupChildren.length || null,
      models: uniqueModels.join(', '),
      children: groupChildren.map(c => {
        const caps = c.capabilities || [];
        return {
          deviceId: c.device_id,
          name: c.name,
          sku: c.sku,
          modelName: modelMap[c.sku] || c.sku,
          segmentCount: segmentCountMap[c.sku] || 0,
          hasSegments: caps.some(cap => cap.instance === 'segmentedColorRgb'),
          hasScenes: caps.some(cap => cap.instance === 'lightScene'),
        };
      }),
    };
  });

  // Build sections grouped by area
  const sectionMap = new Map();
  for (const group of goveeGroups) {
    if (!sectionMap.has(group.area)) {
      sectionMap.set(group.area, { name: group.area, sectionId: group.area, groups: [] });
    }
    sectionMap.get(group.area).groups.push(group);
  }

  const sections = [...sectionMap.values()].sort((a, b) => {
    const ai = AREA_ORDER.indexOf(a.sectionId);
    const bi = AREA_ORDER.indexOf(b.sectionId);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return { groups: goveeGroups, sections };
}

// =============================================
// CONTROL FUNCTIONS
// =============================================

/**
 * Toggle a group on/off.
 */
export async function toggleGroup(groupId, on) {
  await goveeApi('controlDevice', {
    device: groupId,
    sku: 'SameModeGroup',
    capability: {
      type: 'devices.capabilities.on_off',
      instance: 'powerSwitch',
      value: on ? 1 : 0,
    },
  });
}

/**
 * Set group brightness (1-100).
 */
export async function setBrightness(groupId, value) {
  await goveeApi('controlDevice', {
    device: groupId,
    sku: 'SameModeGroup',
    capability: {
      type: 'devices.capabilities.range',
      instance: 'brightness',
      value: parseInt(value),
    },
  });
}

/**
 * Set group color by hex string.
 */
export async function setColor(groupId, hexColor) {
  await goveeApi('controlDevice', {
    device: groupId,
    sku: 'SameModeGroup',
    capability: {
      type: 'devices.capabilities.color_setting',
      instance: 'colorRgb',
      value: hexToRgbInt(hexColor),
    },
  });
}

/**
 * Set group color temperature in Kelvin.
 */
export async function setColorTemp(groupId, temp) {
  await goveeApi('controlDevice', {
    device: groupId,
    sku: 'SameModeGroup',
    capability: {
      type: 'devices.capabilities.color_setting',
      instance: 'colorTemperatureK',
      value: parseInt(temp),
    },
  });
}

/**
 * Get device state from Govee API.
 */
export async function getDeviceState(deviceId, sku = 'SameModeGroup') {
  const result = await goveeApi('getDeviceState', { device: deviceId, sku });
  if (!result.payload) return null;

  const capabilities = result.payload.capabilities || [];
  const state = { disconnected: false };

  for (const cap of capabilities) {
    if (cap.instance === 'powerSwitch') state.on = cap.state?.value === 1;
    else if (cap.instance === 'brightness') state.brightness = cap.state?.value;
    else if (cap.instance === 'colorRgb') state.color = rgbIntToHex(cap.state?.value);
    else if (cap.instance === 'colorTemperatureK') state.colorTemp = cap.state?.value;
    else if (cap.instance === 'online' && cap.state?.value === false) state.disconnected = true;
  }

  return state;
}

/**
 * Turn all groups off.
 * @param {Array} groups - Array of group objects with groupId
 * @returns {Promise<{successes: number, failures: number}>}
 */
export async function allOff(groups) {
  let successes = 0, failures = 0;
  for (const group of groups) {
    try {
      await toggleGroup(group.groupId, false);
      successes++;
    } catch { failures++; }
    await new Promise(r => setTimeout(r, 200));
  }
  return { successes, failures };
}

// =============================================
// UTILITIES
// =============================================

export function hexToRgbInt(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return r * 65536 + g * 256 + b;
}

export function rgbIntToHex(value) {
  if (value == null) return null;
  const r = (value >> 16) & 0xFF;
  const g = (value >> 8) & 0xFF;
  const b = value & 0xFF;
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}
