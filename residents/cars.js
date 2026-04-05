/**
 * Cars Page - Vehicle fleet overview with live data from vehicles table.
 * Poller on DO droplet writes vehicle state; this page reads it every 30s.
 */

import { supabase } from '../shared/supabase.js';
import { initResidentPage, showToast } from '../shared/resident-shell.js';
import { hasPermission } from '../shared/auth.js';
import { PollManager } from '../shared/services/poll-manager.js';
import { supabaseHealth } from '../shared/supabase-health.js';

// =============================================
// CONFIGURATION
// =============================================
const POLL_INTERVAL_MS = 30000; // 30s (reads from Supabase, not Tesla API)

// =============================================
// STATE
// =============================================
let vehicles = [];
let accounts = [];
let poll = null;
let currentUserRole = null;
let currentUserId = null;    // app_users.id
let currentPersonId = null;  // people.id (for ownership matching)
const leafletMaps = {};       // car.id → Leaflet map instance
const geocodeCache = {};      // "lat,lng" → address string

// =============================================
// SVG ICONS (inline for data rows)
// =============================================
const ICONS = {
  battery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="18" height="12" rx="2"/><line x1="23" y1="10" x2="23" y2="14"/></svg>',
  odometer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  status: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  climate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>',
  location: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  tires: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="22"/><line x1="2" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="22" y2="12"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 5-5 5 5 0 0 1 4.33 2.5"/></svg>',
  doors: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h7l2-2v8l-2-2H3"/></svg>',
  sentry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  software: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  charging: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
};

// =============================================
// TESLA SOFTWARE → FSD VERSION + RELEASE DATE
// =============================================
// Maps Tesla firmware version prefixes to FSD version and release date.
// Longest prefix match wins (e.g., "2025.45.9" matches before "2025.45").
const TESLA_SW_MAP = [
  { prefix: '2026.2.3',      fsd: '12.6.4 / 13.2.9', date: 'Jan 27, 2026', latest: true },
  { prefix: '2026.2',        fsd: '12.6.4 / 13.2.9', date: 'Jan 2026',     latest: true },
  { prefix: '2025.45.9',     fsd: '14.2.2.4',         date: 'Jan 24, 2026', latest: true },
  { prefix: '2025.45.8',     fsd: '14.2.2.3',         date: 'Jan 13, 2026' },
  { prefix: '2025.45.7',     fsd: '14.2.2.2',         date: 'Dec 29, 2025' },
  { prefix: '2025.45.6',     fsd: '14.2.2.1',         date: 'Dec 24, 2025' },
  { prefix: '2025.45.5',     fsd: '14.2.2',           date: 'Dec 22, 2025' },
  { prefix: '2025.45',       fsd: '14.2',             date: 'Dec 2025' },
  { prefix: '2025.47.5',     fsd: '14.1.4',           date: 'Dec 25, 2025' },
  { prefix: '2025.46.5',     fsd: '13.2.9',           date: 'Dec 23, 2025' },
  { prefix: '2025.44.25.4',  fsd: '12.6.4 / 13.2.9', date: 'Dec 19, 2025' },
  { prefix: '2025.44.25',    fsd: '12.6.4 / 13.2.9', date: 'Dec 2025' },
  { prefix: '2025.44',       fsd: '12.6.4',           date: 'Nov 2025' },
];

function lookupFSD(softwareVersion) {
  if (!softwareVersion) return null;
  // Find longest matching prefix
  let best = null;
  for (const entry of TESLA_SW_MAP) {
    if (softwareVersion.startsWith(entry.prefix)) {
      if (!best || entry.prefix.length > best.prefix.length) best = entry;
    }
  }
  return best;
}

// Tesla car SVG silhouettes (fallback when images fail to load)
const CAR_SVG = {
  model3: `<svg viewBox="0 0 400 160" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M50 110 C50 110 55 65 90 55 L160 45 C170 43 200 38 240 38 L310 42 C340 48 360 65 365 80 L370 95 C372 100 370 110 365 110" stroke="currentColor" stroke-width="3" fill="none"/>
    <path d="M90 55 C95 50 160 45 160 45" stroke="currentColor" stroke-width="2" fill="none"/>
    <path d="M160 45 L240 38" stroke="currentColor" stroke-width="2" fill="none"/>
    <path d="M240 38 C260 40 280 42 310 42" stroke="currentColor" stroke-width="2" fill="none"/>
    <line x1="160" y1="45" x2="155" y2="80" stroke="currentColor" stroke-width="2"/>
    <line x1="240" y1="38" x2="245" y2="80" stroke="currentColor" stroke-width="2"/>
    <circle cx="105" cy="112" r="22" stroke="currentColor" stroke-width="3" fill="none"/>
    <circle cx="105" cy="112" r="12" stroke="currentColor" stroke-width="2" fill="none"/>
    <circle cx="315" cy="112" r="22" stroke="currentColor" stroke-width="3" fill="none"/>
    <circle cx="315" cy="112" r="12" stroke="currentColor" stroke-width="2" fill="none"/>
    <line x1="50" y1="112" x2="83" y2="112" stroke="currentColor" stroke-width="2"/>
    <line x1="127" y1="112" x2="293" y2="112" stroke="currentColor" stroke-width="2"/>
    <line x1="337" y1="112" x2="365" y2="112" stroke="currentColor" stroke-width="2"/>
  </svg>`,
  modelY: `<svg viewBox="0 0 400 160" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M45 115 C45 112 48 70 85 52 L150 40 C165 37 200 33 245 33 L315 38 C345 45 362 65 368 82 L373 98 C375 105 372 115 368 115" stroke="currentColor" stroke-width="3" fill="none"/>
    <path d="M85 52 C90 47 150 40 150 40" stroke="currentColor" stroke-width="2" fill="none"/>
    <path d="M150 40 L245 33" stroke="currentColor" stroke-width="2" fill="none"/>
    <path d="M245 33 C270 35 290 37 315 38" stroke="currentColor" stroke-width="2" fill="none"/>
    <line x1="150" y1="40" x2="148" y2="82" stroke="currentColor" stroke-width="2"/>
    <line x1="245" y1="33" x2="248" y2="82" stroke="currentColor" stroke-width="2"/>
    <path d="M85 52 C82 58 78 75 76 85" stroke="currentColor" stroke-width="2" fill="none"/>
    <circle cx="105" cy="117" r="23" stroke="currentColor" stroke-width="3" fill="none"/>
    <circle cx="105" cy="117" r="13" stroke="currentColor" stroke-width="2" fill="none"/>
    <circle cx="318" cy="117" r="23" stroke="currentColor" stroke-width="3" fill="none"/>
    <circle cx="318" cy="117" r="13" stroke="currentColor" stroke-width="2" fill="none"/>
    <line x1="45" y1="117" x2="82" y2="117" stroke="currentColor" stroke-width="2"/>
    <line x1="128" y1="117" x2="295" y2="117" stroke="currentColor" stroke-width="2"/>
    <line x1="341" y1="117" x2="368" y2="117" stroke="currentColor" stroke-width="2"/>
  </svg>`,
};

// Generic car silhouette for non-Tesla vehicles
const CAR_SVG_GENERIC = `<svg viewBox="0 0 400 160" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M55 115 C55 110 60 70 95 55 L165 42 C180 38 210 34 250 34 L320 40 C350 48 365 68 370 85 L375 100 C377 106 374 115 370 115" stroke="currentColor" stroke-width="3" fill="none"/>
  <line x1="165" y1="42" x2="160" y2="82" stroke="currentColor" stroke-width="2"/>
  <line x1="250" y1="34" x2="253" y2="82" stroke="currentColor" stroke-width="2"/>
  <circle cx="110" cy="117" r="22" stroke="currentColor" stroke-width="3" fill="none"/>
  <circle cx="110" cy="117" r="12" stroke="currentColor" stroke-width="2" fill="none"/>
  <circle cx="320" cy="117" r="22" stroke="currentColor" stroke-width="3" fill="none"/>
  <circle cx="320" cy="117" r="12" stroke="currentColor" stroke-width="2" fill="none"/>
  <line x1="55" y1="117" x2="88" y2="117" stroke="currentColor" stroke-width="2"/>
  <line x1="132" y1="117" x2="298" y2="117" stroke="currentColor" stroke-width="2"/>
  <line x1="342" y1="117" x2="370" y2="117" stroke="currentColor" stroke-width="2"/>
</svg>`;

// =============================================
// DATA LOADING
// =============================================

function isNearHome(car) {
  const s = car.last_state;
  if (!s?.latitude || !s?.longitude) return false;
  return Math.abs(s.latitude - HOME_LAT) < 0.002 && Math.abs(s.longitude - HOME_LNG) < 0.002;
}

function isChargingAtHome(car) {
  const s = car.last_state;
  if (!s) return false;
  const isCharging = s.charging_state === 'Charging' || s.charging_state === 'Complete';
  return isCharging && isNearHome(car);
}

function filterVehiclesForUser(allVehicles) {
  // Users with admin_cars_settings or control_cars see everything
  if (hasPermission('admin_cars_settings') || hasPermission('control_cars')) return allVehicles;

  return allVehicles.filter(car => {
    // User owns this vehicle
    if (car.owner_id === currentUserId) return true;
    // User is a driver (match via person_id)
    if (currentPersonId && (car.drivers || []).some(d => d.person?.id === currentPersonId)) return true;
    // Vehicle is charging at the house
    if (isChargingAtHome(car)) return true;
    return false;
  });
}

async function loadVehicles() {
  const { data, error } = await supabase
    .from('vehicles')
    .select('*, account:account_id(id, owner_name, tesla_email, app_user_id), owner:owner_id(id, first_name, last_name), drivers:vehicle_drivers(person:person_id(id, first_name, last_name))')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) {
    console.warn('Failed to load vehicles:', error.message);
    supabaseHealth.recordFailure();
    throw error;
  }
  supabaseHealth.recordSuccess();
  vehicles = filterVehiclesForUser(data || []);
}

async function loadAccounts() {
  let query = supabase
    .from('tesla_accounts')
    .select('id, owner_name, tesla_email, is_active, last_error, needs_reauth, refresh_token, updated_at, app_user_id')
    .order('id', { ascending: true });

  // Non-admins only see their own accounts
  if (!hasPermission('admin_cars_settings')) {
    query = query.eq('app_user_id', currentUserId);
  }

  const { data, error } = await query;
  if (error) {
    console.warn('Failed to load accounts:', error.message);
    return;
  }
  accounts = data || [];
}

// =============================================
// HELPERS
// =============================================

function formatSyncTime(lastSyncedAt) {
  if (!lastSyncedAt) return 'Never synced';
  const diff = Date.now() - new Date(lastSyncedAt).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return new Date(lastSyncedAt).toLocaleDateString();
}

function formatNumber(n) {
  if (n == null) return '--';
  return n.toLocaleString();
}

function getStatusDisplay(car) {
  const s = car.last_state;
  if (car.vehicle_state === 'asleep') return { text: 'Asleep', color: 'var(--text-muted)' };
  if (car.vehicle_state === 'offline') return { text: 'Offline', color: 'var(--occupied, #e74c3c)' };
  if (!s) return { text: '--', color: 'var(--text-muted)' };
  if (s.charging_state === 'Charging') return { text: 'Charging', color: 'var(--available, #27ae60)' };
  if (s.charging_state === 'Complete') return { text: 'Charge Complete', color: 'var(--available, #27ae60)' };
  return { text: 'Online', color: 'var(--available, #27ae60)' };
}

function getClosuresStr(s) {
  // Build list of open closures (0 = closed, non-zero = open)
  const open = [];
  if (s.df) open.push('Driver');
  if (s.pf) open.push('Passenger');
  if (s.dr) open.push('Rear L');
  if (s.pr) open.push('Rear R');
  if (s.ft) open.push('Frunk');
  if (s.rt) open.push('Trunk');
  // Windows
  const windowsOpen = [];
  if (s.fd_window) windowsOpen.push('FL');
  if (s.fp_window) windowsOpen.push('FR');
  if (s.rd_window) windowsOpen.push('RL');
  if (s.rp_window) windowsOpen.push('RR');

  if (s.df == null && s.ft == null) return '--';
  const parts = [];
  if (open.length === 0 && windowsOpen.length === 0) return 'All closed';
  if (open.length > 0) parts.push(`<span style="color:var(--occupied,#e74c3c)">${open.join(', ')} open</span>`);
  if (windowsOpen.length > 0) parts.push(`<span style="color:var(--occupied,#e74c3c)">Windows: ${windowsOpen.join(', ')}</span>`);
  return parts.join(' \u00b7 ');
}

function getChargingDetail(s) {
  if (s.charging_state !== 'Charging') return '';
  const parts = [];
  if (s.charger_power_kw != null && s.charger_power_kw > 0) parts.push(`${s.charger_power_kw} kW`);
  if (s.charge_rate_mph != null && s.charge_rate_mph > 0) parts.push(`${s.charge_rate_mph} mi/hr`);
  if (s.minutes_to_full != null && s.minutes_to_full > 0) {
    const hrs = Math.floor(s.minutes_to_full / 60);
    const mins = s.minutes_to_full % 60;
    parts.push(hrs > 0 ? `${hrs}h ${mins}m left` : `${mins}m left`);
  }
  return parts.length ? ` \u00b7 ${parts.join(' \u00b7 ')}` : '';
}

function getDataRows(car) {
  const s = car.last_state;
  if (!s) {
    // No data yet — show placeholders
    return [
      { label: 'Battery', icon: 'battery', value: '--' },
      { label: 'Odometer', icon: 'odometer', value: '--' },
      { label: 'Status', icon: 'status', value: car.vehicle_state === 'unknown' ? 'Not connected' : car.vehicle_state },
      { label: 'Climate', icon: 'climate', value: '--' },
      { label: 'Location', icon: 'location', value: '--' },
      { label: 'Doors', icon: 'doors', value: '--' },
      { label: 'Tires', icon: 'tires', value: '--' },
      { label: 'Locked', icon: 'lock', value: '--' },
    ];
  }

  const status = getStatusDisplay(car);
  const batteryStr = s.battery_level != null
    ? `${s.battery_level}%${s.charge_limit_soc != null ? ` / ${s.charge_limit_soc}%` : ''}${s.battery_range_mi != null ? ` \u00b7 ${Math.round(s.battery_range_mi)} mi` : ''}`
    : '--';
  // Charging row — only when actively charging or complete
  let chargingStr = null;
  if (s.charging_state === 'Charging') {
    const cp = [];
    if (s.charger_power_kw != null && s.charger_power_kw > 0) cp.push(`${s.charger_power_kw} kW`);
    if (s.charge_rate_mph != null && s.charge_rate_mph > 0) cp.push(`${s.charge_rate_mph} mi/hr`);
    if (s.minutes_to_full != null && s.minutes_to_full > 0) {
      const hrs = Math.floor(s.minutes_to_full / 60);
      const mins = s.minutes_to_full % 60;
      cp.push(hrs > 0 ? `${hrs}h ${mins}m left` : `${mins}m left`);
    }
    chargingStr = cp.length ? cp.join(' \u00b7 ') : 'Charging';
  } else if (s.charging_state === 'Complete') {
    chargingStr = 'Complete';
  }
  const climateStr = s.climate_on
    ? `${s.inside_temp_f || '--'}\u00b0F (on)${s.outside_temp_f != null ? ` \u00b7 ${s.outside_temp_f}\u00b0F outside` : ''}`
    : s.inside_temp_f != null ? `${s.inside_temp_f}\u00b0F (off)${s.outside_temp_f != null ? ` \u00b7 ${s.outside_temp_f}\u00b0F outside` : ''}` : '--';
  const hasLocation = s.latitude != null && s.longitude != null;
  let locationStr = '--';
  if (hasLocation) {
    const speedSuffix = (s.speed_mph != null && s.speed_mph > 0) ? ` \u00b7 ${s.speed_mph} mph` : '';
    const coordsText = `${s.latitude.toFixed(4)}, ${s.longitude.toFixed(4)}${speedSuffix}`;
    locationStr = `<span class="car-location-toggle" onclick="window._toggleMap(${car.id})" title="Show on map"><span id="locText_${car.id}">${coordsText}</span></span>`;
  }
  let tiresStr = '--';
  if (s.tpms_fl_psi != null) {
    const warnColor = 'color:var(--occupied,#e74c3c);font-weight:600';
    const fl = s.tpms_warn_fl ? `<span style="${warnColor}">${s.tpms_fl_psi}</span>` : s.tpms_fl_psi;
    const fr = s.tpms_warn_fr ? `<span style="${warnColor}">${s.tpms_fr_psi}</span>` : s.tpms_fr_psi;
    const rl = s.tpms_warn_rl ? `<span style="${warnColor}">${s.tpms_rl_psi}</span>` : s.tpms_rl_psi;
    const rr = s.tpms_warn_rr ? `<span style="${warnColor}">${s.tpms_rr_psi}</span>` : s.tpms_rr_psi;
    tiresStr = `${fl} / ${fr} / ${rl} / ${rr}`;
    const hasWarn = s.tpms_warn_fl || s.tpms_warn_fr || s.tpms_warn_rl || s.tpms_warn_rr;
    if (hasWarn) tiresStr += ' <span style="color:var(--occupied,#e74c3c);font-size:0.75rem">\u26a0</span>';
  }
  const lockStr = s.locked === true ? 'Locked' : s.locked === false ? 'Unlocked' : '--';
  const sentryStr = s.sentry_mode === true ? 'On' : s.sentry_mode === false ? 'Off' : '--';
  const closuresStr = getClosuresStr(s);

  const rows = [
    { label: 'Battery', icon: 'battery', value: batteryStr },
  ];
  if (chargingStr) rows.push({ label: 'Charging', icon: 'charging', value: `<span style="color:var(--available,#27ae60)">${chargingStr}</span>` });
  rows.push(
    { label: 'Odometer', icon: 'odometer', value: s.odometer_mi != null ? `${formatNumber(Math.round(s.odometer_mi))} mi` : '--' },
    { label: 'Status', icon: 'status', value: `<span style="color:${status.color}">${status.text}</span>` },
    { label: 'Climate', icon: 'climate', value: climateStr },
    { label: 'Location', icon: 'location', value: locationStr },
    { label: 'Doors', icon: 'doors', value: closuresStr },
    { label: 'Tires', icon: 'tires', value: tiresStr },
    { label: 'Locked', icon: 'lock', value: lockStr },
    { label: 'Sentry', icon: 'sentry', value: sentryStr },
  );

  // Software version + update status + FSD info (Tesla-specific)
  if (s.software_version && car.vehicle_make === 'Tesla') {
    let swStr = s.software_version;
    if (s.software_update) {
      const upd = s.software_update;
      if (upd.status === 'available') {
        swStr += ` \u00b7 <span style="color:var(--available,#27ae60)">Update available${upd.version ? ': ' + upd.version : ''}</span>`;
      } else if (upd.status === 'downloading') {
        swStr += ` \u00b7 Downloading ${upd.download_pct ?? 0}%`;
      } else if (upd.status === 'installing') {
        swStr += ` \u00b7 Installing ${upd.install_pct ?? 0}%`;
      } else if (upd.status === 'scheduled') {
        swStr += ' \u00b7 Update scheduled';
      }
    }
    const fsdInfo = lookupFSD(s.software_version);
    if (fsdInfo) {
      const fsdLabel = fsdInfo.latest
        ? `<span style="font-size:0.85rem;font-weight:700">FSD ${fsdInfo.fsd}</span> <span style="font-size:0.7rem;font-weight:600;color:var(--available,#27ae60);background:rgba(39,174,96,0.1);padding:1px 5px;border-radius:3px;vertical-align:middle">Latest</span>`
        : `<span style="font-size:0.85rem;font-weight:700">FSD ${fsdInfo.fsd}</span> <span style="font-size:0.7rem;font-weight:600;color:var(--occupied,#e74c3c);background:rgba(231,76,60,0.1);padding:1px 5px;border-radius:3px;vertical-align:middle">Update available</span>`;
      swStr += `<br>${fsdLabel} <span style="font-size:0.75rem;color:var(--text-muted)">\u00b7 ${fsdInfo.date}</span>`;
    }
    rows.push({ label: 'Software', icon: 'software', value: swStr });
  }

  return rows;
}

// =============================================
// VEHICLE CONFIG HELPERS
// =============================================

function getConfigSubtitle(car) {
  const vc = car.vehicle_config;
  if (!vc) return '';
  const parts = [];
  // Trim badging (e.g., "74d" → "Long Range Dual Motor", "p74d" → "Performance")
  if (vc.trim_badging) parts.push(vc.trim_badging.toUpperCase());
  // Wheel type (e.g., "Apollo19" → "19\" wheels")
  if (vc.wheel_type) {
    const match = vc.wheel_type.match(/(\d+)/);
    if (match) parts.push(`${match[1]}" wheels`);
  }
  return parts.length ? ` \u00b7 ${parts.join(' \u00b7 ')}` : '';
}

// =============================================
// RENDERING
// =============================================

function renderFleet() {
  const grid = document.getElementById('carGrid');
  if (!grid) return;

  if (!vehicles.length) {
    grid.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No vehicles configured.</p>';
    return;
  }

  grid.innerHTML = vehicles.map(car => {
    const isTesla = car.vehicle_make === 'Tesla';
    const hasApiConnection = !!car.account_id;
    const svgKey = car.svg_key || 'modelY';
    const carSvg = CAR_SVG[svgKey] || CAR_SVG.modelY;
    const svgColor = car.color === 'Grey' ? '#777' : '#999';

    // Image with Tesla SVG fallback
    let imageContent;
    if (car.image_url) {
      const fallback = isTesla
        ? `<div class="car-card__svg-fallback" style="display:none;color:${svgColor}">${carSvg}</div>`
        : '';
      imageContent = `<img src="${car.image_url}" alt="${car.name} - ${car.year} ${car.vehicle_model}"
             class="car-card__img"
             onerror="this.style.display='none';${isTesla ? "this.nextElementSibling.style.display='flex';" : ''}"
         />${fallback}`;
    } else if (isTesla) {
      imageContent = `<div class="car-card__svg-fallback" style="color:${svgColor}">${carSvg}</div>`;
    } else {
      imageContent = `<div class="car-card__svg-fallback" style="color:#bbb">${CAR_SVG_GENERIC}</div>`;
    }

    // Owner + drivers info
    let ownerHtml = '';
    const ownerName = car.owner ? `${car.owner.first_name || ''} ${car.owner.last_name || ''}`.trim() : car.account?.owner_name;
    if (ownerName) {
      const driverNames = (car.drivers || []).map(d => d.person ? `${d.person.first_name || ''} ${d.person.last_name || ''}`.trim() : null).filter(Boolean);
      const driverStr = driverNames.length ? ` \u00b7 ${driverNames.join(', ')}` : '';
      ownerHtml = `<div class="car-card__owner">${ownerName}${driverStr}</div>`;
    }

    const configSubtitle = isTesla ? getConfigSubtitle(car) : '';

    // For vehicles with API connection, show full live data grid
    let dataContentHtml = '';
    if (hasApiConnection) {
      const dataRows = getDataRows(car);
      const dataRowsHtml = dataRows.map(row => `
        <div class="car-data-row">
          <span class="car-data-row__icon">${ICONS[row.icon]}</span>
          <span class="car-data-row__label">${row.label}</span>
          <span class="car-data-row__value">${row.value}</span>
        </div>
      `).join('');

      dataContentHtml = `
          <div class="car-data-grid">${dataRowsHtml}</div>
          <div class="car-card__map-panel" id="mapPanel_${car.id}" style="display:none;">
            <div class="car-card__map-address" id="mapAddr_${car.id}"></div>
            <div class="car-card__map" id="map_${car.id}"></div>
          </div>`;
    } else {
      // Non-API vehicle — show basic details
      const details = [];
      if (car.license_plate) details.push(`<span>Plate: ${car.license_plate}</span>`);
      if (car.vehicle_length_ft) details.push(`<span>Length: ${car.vehicle_length_ft} ft</span>`);
      if (details.length) {
        dataContentHtml = `<div class="car-card__basic-details">${details.join(' \u00b7 ')}</div>`;
      }
    }

    // Tesla-specific controls (lock/unlock, flash) — only when API connected
    let controlsHtml = '';
    if (isTesla && hasApiConnection) {
      // Check if user is owner or assigned driver
      const isOwner = (currentPersonId && car.owner_id === currentPersonId) || car.account?.app_user_id === currentUserId;
      const isDriver = currentPersonId && (car.drivers || []).some(d => d.person?.id === currentPersonId);
      const isOwnCar = isOwner || isDriver;

      // Non-owners can only control if battery >50% AND plugged in
      const batteryLevel = car.last_state?.battery_level;
      const chargingState = car.last_state?.charging_state;
      const pluggedIn = chargingState && chargingState !== 'Disconnected';
      const batteryOk = typeof batteryLevel === 'number' && batteryLevel > 50;
      const canControl = isOwnCar || (batteryOk && pluggedIn);

      const isLocked = car.last_state?.locked;
      const lockIcon = isLocked === false ? ICONS.unlock : ICONS.lock;
      const nextCmd = isLocked === false ? 'door_lock' : 'door_unlock';
      const nextLabel = isLocked === false ? 'Lock' : 'Unlock';
      const isCharging = chargingState === 'Charging' || chargingState === 'Complete';
      const showChargerHint = isCharging && isLocked !== false;
      const lockBtnClass = showChargerHint
        ? 'car-cmd-btn car-cmd-btn--charger-unlock'
        : 'car-cmd-btn';
      const lockBtnLabel = showChargerHint ? 'Unlock to Move Off Charger' : nextLabel;

      if (canControl) {
        controlsHtml = `
          <div class="car-card__controls">
            <button class="${lockBtnClass}" id="lockBtn_${car.id}"
                    onclick="window._sendCommand(${car.id}, '${nextCmd}')"
                    title="${lockBtnLabel}">
              <span class="car-cmd-btn__icon">${lockIcon}</span>
              <span class="car-cmd-btn__label">${lockBtnLabel}</span>
            </button>
            <button class="car-cmd-btn car-cmd-btn--secondary" id="flashBtn_${car.id}"
                    onclick="window._sendCommand(${car.id}, 'flash_lights')"
                    title="Flash lights">
              <span class="car-cmd-btn__label">Flash</span>
            </button>
          </div>`;
      } else if (!isOwnCar) {
        // Show why controls are disabled for non-owners
        const reasons = [];
        if (!pluggedIn) reasons.push('not plugged in');
        if (!batteryOk) reasons.push(`${batteryLevel ?? '?'}% charged`);
        controlsHtml = `
          <div class="car-card__controls-disabled" style="font-size:0.8rem;color:var(--text-muted);padding:0.5rem 0;text-align:center;">
            Controls locked — ${reasons.join(', ')}
          </div>`;
      }
    }

    const syncTimeHtml = hasApiConnection
      ? `<div class="car-card__sync-time">${formatSyncTime(car.last_synced_at)}</div>`
      : '';

    return `
      <div class="car-card">
        <div class="car-card__image">
          ${imageContent}
        </div>
        <div class="car-card__info">
          ${ownerHtml}
          <div class="car-card__header">
            <div class="car-card__name">${car.name}</div>
            <span class="car-card__color-chip">
              <span class="car-card__color-dot" style="background:${car.color_hex || '#ccc'}"></span>
              ${car.color || ''}
            </span>
          </div>
          <div class="car-card__model">${car.year || ''} ${car.vehicle_make ? car.vehicle_make + ' ' : ''}${car.vehicle_model || ''}${configSubtitle}</div>
          ${dataContentHtml}
          ${controlsHtml}
          ${syncTimeHtml}
        </div>
      </div>
    `;
  }).join('');
}

// =============================================
// MAP TOGGLE
// =============================================

window._toggleMap = function(carId) {
  const panel = document.getElementById(`mapPanel_${carId}`);
  if (!panel) return;

  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? '' : 'none';

  if (isHidden) {
    initMap(carId);
  }
};

function initMap(carId) {
  const car = vehicles.find(v => v.id === carId);
  if (!car?.last_state?.latitude) return;

  const lat = car.last_state.latitude;
  const lng = car.last_state.longitude;
  const mapEl = document.getElementById(`map_${carId}`);
  if (!mapEl) return;

  // Destroy previous map if exists
  if (leafletMaps[carId]) {
    leafletMaps[carId].remove();
    delete leafletMaps[carId];
  }

  const map = L.map(mapEl, { zoomControl: false }).setView([lat, lng], 15);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OSM',
    maxZoom: 19,
  }).addTo(map);

  L.marker([lat, lng]).addTo(map)
    .bindPopup(`<b>${car.name}</b>`).openPopup();

  leafletMaps[carId] = map;

  // Fix tile rendering after panel becomes visible
  setTimeout(() => map.invalidateSize(), 100);

  // Reverse geocode the address label above the map
  reverseGeocodeMapLabel(carId, lat, lng);
}

async function reverseGeocodeMapLabel(carId, lat, lng) {
  const addrEl = document.getElementById(`mapAddr_${carId}`);
  if (!addrEl) return;
  addrEl.textContent = 'Resolving address...';
  const addr = await reverseGeocodeToString(lat, lng);
  addrEl.textContent = addr;
}

// =============================================
// REVERSE GEOCODING
// =============================================

function formatShortAddress(data) {
  const a = data.address || {};
  const parts = [];
  const street = a.house_number ? `${a.house_number} ${a.road || ''}` : (a.road || '');
  if (street.trim()) parts.push(street.trim());
  const city = a.city || a.town || a.village || a.hamlet || a.county || '';
  if (city) parts.push(city);
  if (a.state) parts.push(a.state);
  return parts.join(', ') || data.display_name || 'Unknown';
}

// Home address override — Nominatim returns wrong house number for this location
const HOME_LAT = 30.13;
const HOME_LNG = -97.46;
const HOME_ADDR = '123 Main St, Your City, Texas';

async function reverseGeocodeToString(lat, lng) {
  // If within ~200m of home, use known correct address
  if (Math.abs(lat - HOME_LAT) < 0.002 && Math.abs(lng - HOME_LNG) < 0.002) {
    return HOME_ADDR;
  }

  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (geocodeCache[key]) return geocodeCache[key];

  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
      { headers: { 'Accept-Language': 'en' } }
    );
    if (!resp.ok) throw new Error('Geocode failed');
    const data = await resp.json();
    const short = formatShortAddress(data);
    geocodeCache[key] = short;
    return short;
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

async function resolveAllAddresses() {
  for (const car of vehicles) {
    const s = car.last_state;
    if (!s?.latitude || !s?.longitude) continue;
    const el = document.getElementById(`locText_${car.id}`);
    if (!el) continue;
    const addr = await reverseGeocodeToString(s.latitude, s.longitude);
    const speedSuffix = (s.speed_mph != null && s.speed_mph > 0) ? ` \u00b7 ${s.speed_mph} mph` : '';
    el.textContent = `${addr}${speedSuffix}`;
  }
}

// =============================================
// ADD VEHICLE CTA
// =============================================

function updateAddVehicleCta() {
  const cta = document.getElementById('addVehicleCta');
  if (!cta) return;
  const userOwnsAny = vehicles.some(v => v.owner?.id === currentPersonId);
  cta.style.display = userOwnsAny ? 'none' : '';
}

// =============================================
// ADMIN: SETTINGS
// =============================================

function renderSettings() {
  const section = document.getElementById('teslaSettingsSection');
  const list = document.getElementById('teslaAccountsList');
  if (!section || !list) return;

  // Show if user has any tesla accounts (or is admin)
  if (!accounts.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  list.innerHTML = accounts.map(acc => {
    const hasError = !!acc.last_error;
    const needsReauth = !!acc.needs_reauth;
    const hasToken = !!acc.refresh_token;
    const isHealthy = hasToken && !hasError && !needsReauth;

    const statusDot = isHealthy
      ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--available, #27ae60);margin-right:0.4rem;"></span>'
      : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--occupied, #e74c3c);margin-right:0.4rem;"></span>';

    let statusText = 'Not connected';
    if (needsReauth) statusText = 'Re-authorization required';
    else if (isHealthy) statusText = 'Connected';
    else if (hasError) statusText = 'Needs reconnection';

    let errorHtml = '';
    if (needsReauth) {
      errorHtml = `<div style="font-size:0.8rem;color:var(--occupied, #e74c3c);margin-top:0.25rem;font-weight:500;">Session expired \u2014 click Reconnect to re-authorize with Tesla.</div>`;
    } else if (hasError) {
      errorHtml = `<div style="font-size:0.8rem;color:var(--occupied, #e74c3c);margin-top:0.25rem;">Token error \u2014 click Reconnect to re-authorize with Tesla.</div>`;
    }

    let connectBtn;
    if (needsReauth || hasError) {
      connectBtn = `<button class="btn-primary" onclick="window._connectTesla(${acc.id})" style="background:var(--occupied,#e74c3c);border-color:var(--occupied,#e74c3c);">Reconnect</button>`;
    } else if (isHealthy) {
      connectBtn = `<button class="btn-secondary" onclick="window._disconnectTesla(${acc.id})" style="color:var(--occupied,#e74c3c);border-color:var(--occupied,#e74c3c);">Disconnect</button>`;
    } else {
      connectBtn = `<button class="btn-primary" onclick="window._connectTesla(${acc.id})">Connect Tesla Account</button>`;
    }

    return `
      <div style="display:flex;align-items:center;gap:0.75rem;padding:0.8rem 0;border-bottom:1px solid var(--border-light, #f0f0f0);">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:0.9rem;">${statusDot}${acc.owner_name}</div>
          <div style="font-size:0.8rem;color:var(--text-muted);">${statusText}${acc.tesla_email ? ` \u00b7 ${acc.tesla_email}` : ''}</div>
          ${errorHtml}
        </div>
        ${connectBtn}
      </div>
    `;
  }).join('');
}

// =============================================
// VEHICLE COMMANDS
// =============================================

window._sendCommand = async function(vehicleId, command) {
  const btn = document.getElementById(
    command.startsWith('door_') ? `lockBtn_${vehicleId}` : `flashBtn_${vehicleId}`
  );
  if (btn) {
    btn.disabled = true;
    btn.classList.add('car-cmd-btn--loading');
  }

  try {
    const { data, error } = await supabase.functions.invoke('tesla-command', {
      body: { vehicle_id: vehicleId, command },
    });

    // On non-2xx responses, supabase.functions.invoke sets data=null and error=FunctionsHttpError.
    // The actual error details are in the response body — extract them from error.context.
    let errData = data;
    if (error && !data) {
      try {
        errData = await error.context?.json();
      } catch (_) { /* couldn't parse response body */ }
    }

    if (errData?.error) {
      const detail = errData.details ? ` (${errData.details})` : '';
      // If the account needs re-authorization, show a prominent message
      if (errData.needs_reauth) {
        showToast('Tesla session expired. Please go to Settings and click Reconnect.', 'error');
        // Refresh accounts to show the re-auth state in settings
        await loadAccounts();
        renderSettings();
        return;
      }
      showToast(`${command.replace(/_/g, ' ')}: ${errData.error}${detail}`, 'error');
      return;
    }

    if (error) {
      showToast(`Command failed: ${error.message}`, 'error');
      return;
    }

    const friendlyCmd = command.replace(/_/g, ' ').replace('door ', '');
    showToast(`${data?.vehicle_name || 'Vehicle'}: ${friendlyCmd} sent`, 'success');

    // Refresh data after a short delay
    setTimeout(refreshFromDB, 2000);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('car-cmd-btn--loading');
    }
  }
};

// Disconnect Tesla account — clear tokens
window._disconnectTesla = async function(accountId) {
  if (!confirm('Disconnect this Tesla account? Vehicle data will stop updating until you reconnect.')) return;

  const { error } = await supabase
    .from('tesla_accounts')
    .update({
      refresh_token: null,
      access_token: null,
      token_expires_at: null,
      last_error: null,
      needs_reauth: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', accountId);

  if (error) {
    showToast(`Failed to disconnect: ${error.message}`, 'error');
    return;
  }

  showToast('Tesla account disconnected', 'success');
  await loadAccounts();
  renderSettings();
};

// Connect Tesla account via OAuth flow
window._connectTesla = async function(accountId) {
  // Immediate visual feedback on the clicked button
  try {
    const btn = event?.target?.closest?.('button') || event?.target;
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting\u2026'; btn.style.opacity = '0.6'; }
  } catch(_) {}

  // Build Tesla OAuth URL — callback page gets a fresh session from localStorage
  const state = `${accountId}`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: '3f53a292-07b8-443f-b86d-e4aedc37ac10',
    redirect_uri: 'https://YOUR_DOMAIN/auth/tesla/callback',
    scope: 'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds',
    state: state,
    audience: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  });

  window.location.href = `https://auth.tesla.com/oauth2/v3/authorize?${params.toString()}`;
};

// =============================================
// POLLING (visibility-based)
// =============================================

function startPolling() {
  if (poll) poll.stop();
  poll = new PollManager(refreshFromDB, POLL_INTERVAL_MS);
  poll.start();
}

async function refreshFromDB() {
  await loadVehicles();
  renderFleet();
  updateAddVehicleCta();
  resolveAllAddresses(); // async — patches DOM when ready
}

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  await initResidentPage({
    activeTab: 'devices',
    requiredRole: 'resident',
    onReady: async (authState) => {
      currentUserRole = authState.appUser?.role;
      currentUserId = authState.appUser?.id;
      currentPersonId = authState.appUser?.person_id;

      // Load vehicles and render
      await loadVehicles();
      renderFleet();
      updateAddVehicleCta();
      resolveAllAddresses(); // async — patches DOM when ready

      // Start polling
      startPolling();
      // Refresh when PAI sends vehicle commands
      window.addEventListener('pai-actions', (e) => {
        const carActions = (e.detail?.actions || []).filter(a => a.type === 'control_vehicle');
        if (carActions.length) setTimeout(() => refreshFromDB(), 3000);
      });

      // Load Tesla account settings (self-service for all users)
      await loadAccounts();
      renderSettings();
    },
  });
});
