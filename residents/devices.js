/**
 * Devices Page — Unified device inventory.
 * Fetches all device data from Supabase and renders expandable sections
 * with tabular rows per device category.
 */

import { initResidentPage } from '../shared/resident-shell.js';
import { supabase } from '../shared/supabase.js';
import { loadZones } from '../shared/services/sonos-data.js';

const COLLAPSE_KEY = 'devices-collapsed';
const ALEXA_FALLBACK_CAPTURED_AT = '2026-03-03T03:00:00-06:00';
const ALEXA_FALLBACK_DEVICES = [
  { hostname: 'amazon-67f77a339', name: null, oui: 'Amazon Technologies Inc.', is_wired: false },
  { hostname: 'amazon-7c33ec9c38900cc0', name: null, oui: 'Amazon Technologies Inc.', is_wired: false },
  { hostname: 'amazon-14ea528bd', name: null, oui: 'Amazon Technologies Inc.', is_wired: false },
  { hostname: 'amazon-20cb70679', name: null, oui: 'Amazon Technologies Inc.', is_wired: false },
  { hostname: 'amazon-080d0e2f9', name: null, oui: 'Amazon Technologies Inc.', is_wired: false },
  { hostname: 'echoshow-3bf32cb7f1ef46a6', name: null, oui: 'Amazon Technologies Inc.', is_wired: false },
  { hostname: 'echoshow-9f2eb6d9d752aab3', name: null, oui: 'Amazon Technologies Inc.', is_wired: false },
  { hostname: 'AmazonPlug13A2', name: null, oui: 'Amazon Technologies Inc.', is_wired: false },
  { hostname: 'Blink-Device', name: null, oui: 'Amazon Technologies Inc.', is_wired: false },
  { hostname: null, name: null, oui: 'Amazon Technologies Inc.', is_wired: false },
  { hostname: null, name: null, oui: 'Amazon Technologies Inc.', is_wired: false },
  { hostname: null, name: null, oui: 'Amazon Technologies Inc.', is_wired: false },
];

const CATEGORIES = [
  { id: 'cameras',  label: 'Cameras',      href: 'cameras.html',  linkLabel: 'Camera Feeds' },
  { id: 'lighting', label: 'Lighting',      href: 'lighting.html', linkLabel: 'Lighting Controls' },
  { id: 'music',    label: 'Music',          href: 'sonos.html',    linkLabel: 'Sonos Controls' },
  { id: 'climate',  label: 'Climate',        href: 'climate.html',  linkLabel: 'Climate Controls' },
  { id: 'cars',     label: 'Vehicles',       href: 'cars.html',     linkLabel: 'Vehicle Controls' },
  { id: 'laundry',  label: 'Appliances',      href: 'appliances.html',  linkLabel: 'Appliance Status' },
  { id: 'alexa',    label: 'Alexa',          href: 'https://YOUR_CAMERA_PROXY/clients?search=amazon', linkLabel: 'Router Clients' },
];

/* ── Helpers ── */

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function esc(s) {
  if (!s) return '—';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function statusDot(online) {
  const cls = online ? 'status-live' : 'status-offline';
  return `<span class="status-dot ${cls}"></span>`;
}

/* ── Property Location ── */

let propertyGps = null;

async function fetchPropertyGps() {
  try {
    const { data } = await supabase
      .from('spaces')
      .select('gps')
      .is('parent_id', null)
      .not('gps', 'is', null)
      .limit(1)
      .single();
    if (data?.gps) propertyGps = data.gps;
  } catch (e) { console.warn('Property GPS fetch failed:', e); }
}

/** Haversine distance in meters between two lat/lng points */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const ONSITE_RADIUS_M = 200; // within 200 meters counts as onsite

/* ── Data Fetchers (all DB, no live API) ── */

async function fetchCameras() {
  try {
    const [streamsRes, spacesRes] = await Promise.all([
      supabase.from('camera_streams').select('camera_name, location, quality, camera_model, is_active').eq('is_active', true).order('camera_name'),
      supabase.from('camera_space_map').select('camera_name, space:space_id(name)'),
    ]);
    if (streamsRes.error) { console.warn('Cameras fetch error:', streamsRes.error); return []; }
    if (!streamsRes.data) return [];
    // Build space name lookup
    const spaceMap = {};
    if (spacesRes.data) {
      for (const row of spacesRes.data) {
        if (!spaceMap[row.camera_name]) spaceMap[row.camera_name] = [];
        if (row.space?.name) spaceMap[row.camera_name].push(row.space.name);
      }
      for (const key of Object.keys(spaceMap)) {
        spaceMap[key] = spaceMap[key].sort().join(', ');
      }
    }
    const map = new Map();
    for (const s of streamsRes.data) {
      if (!map.has(s.camera_name)) {
        map.set(s.camera_name, { name: s.camera_name, location: spaceMap[s.camera_name] || s.location, model: s.camera_model, qualities: [] });
      }
      map.get(s.camera_name).qualities.push(s.quality);
    }
    return [...map.values()].sort((a, b) =>
      (a.model || '').localeCompare(b.model || '') || a.name.localeCompare(b.name)
    );
  } catch (e) { console.warn('Cameras fetch failed:', e); return []; }
}

async function fetchLighting() {
  try {
    const [groupsRes, childrenRes, modelsRes] = await Promise.all([
      supabase.from('govee_devices')
        .select('device_id, name, area, display_order')
        .eq('is_group', true).eq('is_active', true)
        .order('display_order'),
      supabase.from('govee_devices')
        .select('device_id, name, sku, parent_group_id, area')
        .eq('is_group', false).eq('is_active', true)
        .order('name'),
      supabase.from('govee_models')
        .select('sku, model_name'),
    ]);
    const groups = groupsRes.data || [];
    const children = childrenRes.data || [];
    const models = new Map((modelsRes.data || []).map(m => [m.sku, m.model_name]));

    const rows = groups.map(g => {
      const kids = children.filter(c => c.parent_group_id === g.device_id);
      const modelSet = new Set(kids.map(c => models.get(c.sku) || c.sku).filter(Boolean));
      return { name: g.name, area: g.area, deviceCount: kids.length, models: [...modelSet].join(', ') || '—' };
    });

    const ungrouped = children.filter(c => !c.parent_group_id);
    const byArea = new Map();
    for (const u of ungrouped) {
      if (!byArea.has(u.area)) byArea.set(u.area, []);
      byArea.get(u.area).push(u);
    }
    for (const [area, devs] of byArea) {
      const modelSet = new Set(devs.map(d => models.get(d.sku) || d.sku));
      rows.push({ name: `${area} (ungrouped)`, area, deviceCount: devs.length, models: [...modelSet].join(', ') || '—' });
    }
    return rows;
  } catch (e) { console.warn('Lighting fetch failed:', e); return []; }
}

async function fetchSonos() {
  // Try live Sonos API first for real-time playback info
  try {
    const zoneGroups = await loadZones();
    if (zoneGroups.length > 0) {
      // Flatten zone groups into individual zone rows
      const zones = [];
      for (const group of zoneGroups) {
        const state = group.coordinatorState || {};
        const track = state.currentTrack || {};
        const playback = state.playbackState || 'STOPPED';
        const isActive = playback === 'PLAYING' || playback === 'PAUSED_PLAYBACK';
        for (const member of group.members || []) {
          zones.push({
            room_name: member.roomName,
            playbackState: playback,
            volume: member.volume,
            mute: member.mute,
            // Only show track info when the group is actually playing or paused
            trackTitle: isActive ? (track.title || '') : '',
            trackArtist: isActive ? (track.artist || '') : '',
            isCoordinator: member.isCoordinator,
            coordinatorName: group.coordinatorName,
          });
        }
      }
      return zones;
    }
  } catch (e) { console.warn('Sonos live fetch failed, falling back to DB:', e); }

  // Fallback: load from DB (sonos_zones table)
  try {
    const { data, error } = await supabase
      .from('sonos_zones')
      .select('*')
      .eq('is_active', true)
      .order('display_order');
    if (error) { console.warn('Sonos DB fetch error:', error); return []; }
    // Reshape DB rows to match live format
    return (data || []).map(z => {
      const st = z.last_state || {};
      return {
        room_name: z.room_name,
        playbackState: st.playbackState || 'STOPPED',
        volume: st.volume,
        mute: st.mute,
        trackTitle: st.trackTitle || '',
        trackArtist: st.trackArtist || '',
      };
    });
  } catch (e) { console.warn('Sonos fetch failed:', e); return []; }
}

async function fetchClimate() {
  try {
    const { data, error } = await supabase
      .from('nest_devices')
      .select('room_name, device_type, display_order, last_state, is_active')
      .eq('is_active', true)
      .eq('device_type', 'thermostat')
      .order('display_order');
    if (error) { console.warn('Climate fetch error:', error); return []; }
    return data || [];
  } catch (e) { console.warn('Climate fetch failed:', e); return []; }
}

async function fetchVehicles() {
  try {
    const { data, error } = await supabase
      .from('vehicles')
      .select('name, vehicle_make, vehicle_model, year, color, vehicle_state, last_state, last_synced_at, is_active')
      .eq('is_active', true)
      .order('display_order');
    if (error) { console.warn('Vehicles fetch error:', error); return []; }
    return data || [];
  } catch (e) { console.warn('Vehicles fetch failed:', e); return []; }
}

async function fetchLaundry() {
  try {
    const { data, error } = await supabase
      .from('lg_appliances')
      .select('name, device_type, model, last_state, last_synced_at, is_active')
      .eq('is_active', true)
      .order('display_order');
    if (error) { console.warn('Laundry fetch error:', error); return []; }
    return data || [];
  } catch (e) { console.warn('Laundry fetch failed:', e); return []; }
}

async function fetchJsonWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAlexaClients() {
  const endpoint = 'https://YOUR_CAMERA_PROXY/clients';
  const searches = ['alexa', 'echo', 'amazon'];
  let hadProxySuccess = false;

  const results = await Promise.all(searches.map(async (term) => {
    try {
      const rows = await fetchJsonWithTimeout(`${endpoint}?search=${encodeURIComponent(term)}`);
      hadProxySuccess = true;
      return rows;
    } catch (e) {
      console.warn(`Alexa client fetch failed for "${term}":`, e);
      return [];
    }
  }));

  const flat = results.flat().filter(Boolean);
  const seen = new Set();
  const deduped = [];
  for (const item of flat) {
    const key = (item.mac || `${item.ip || ''}-${item.hostname || ''}`).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  // Keep likely Alexa/Echo devices first, then other Amazon-identified clients.
  const isLikelyAlexa = (d) => {
    const hay = `${d.hostname || ''} ${d.name || ''}`.toLowerCase();
    if (hay.includes('alexa') || hay.includes('echo')) return true;
    const oui = String(d.oui || '').toLowerCase();
    return oui.includes('amazon');
  };

  const filtered = deduped
    .filter(isLikelyAlexa)
    .sort((a, b) => {
      const aLabel = (a.name || a.hostname || '').toLowerCase();
      const bLabel = (b.name || b.hostname || '').toLowerCase();
      return aLabel.localeCompare(bLabel);
    });

  if (filtered.length > 0) return filtered;

  if (!hadProxySuccess) {
    // Temporary fallback while cam proxy cannot reach UDM subnet route.
    return ALEXA_FALLBACK_DEVICES.map((d, idx) => ({
      ...d,
      ip: null,
      mac: null,
      last_seen: null,
      _fallback: true,
      _fallbackLabel: `Last known snapshot (${ALEXA_FALLBACK_CAPTURED_AT})`,
      _idx: idx,
    }));
  }

  return filtered;
}

/* ── Row Renderers ── */

function renderCameraRows(cameras) {
  if (!cameras.length) return emptyRow(4);
  return cameras.map(c => `
    <tr>
      <td class="dt-name">${esc(c.name)}</td>
      <td class="dt-location" title="${esc(c.location)}">${esc(c.location)}</td>
      <td class="dt-secondary">${esc(c.model)}</td>
      <td>${c.qualities.map(q => `<span class="dt-badge">${q}</span>`).join(' ')}</td>
    </tr>
  `).join('');
}

function renderLightingRows(groups) {
  if (!groups.length) return emptyRow(4);
  return groups.map(g => `
    <tr>
      <td class="dt-name">${esc(g.name)}</td>
      <td class="dt-location" title="${esc(g.area)}">${esc(g.area)}</td>
      <td class="dt-num">${g.deviceCount}</td>
      <td class="dt-secondary">${esc(g.models)}</td>
    </tr>
  `).join('');
}

function renderSonosRows(zones) {
  if (!zones.length) return emptyRow(4, 'No zones — Sonos API unavailable');
  // Sort: playing first
  const sorted = [...zones].sort((a, b) => {
    const playing = x => x.playbackState === 'PLAYING' ? 0 : 1;
    return playing(a) - playing(b);
  });
  return sorted.map(z => {
    const isPlaying = z.playbackState === 'PLAYING';
    const isPaused = z.playbackState === 'PAUSED_PLAYBACK';
    const rowClass = isPlaying ? 'dt-row-playing' : (isPaused ? 'dt-row-paused' : 'dt-row-idle');
    const vol = z.volume != null ? `${z.volume}%` : '—';
    const stateLabel = isPlaying ? 'Playing' : isPaused ? 'Paused' : 'Idle';
    let nowPlaying = '—';
    if (z.trackTitle) {
      nowPlaying = esc(z.trackTitle);
      if (z.trackArtist) nowPlaying += ` <span class="dt-secondary">— ${esc(z.trackArtist)}</span>`;
    }
    return `
      <tr class="${rowClass}">
        <td class="dt-name">${esc(z.room_name)}</td>
        <td>${stateLabel}</td>
        <td>${nowPlaying}</td>
        <td class="dt-num">${z.mute ? '🔇' : ''} ${vol}</td>
      </tr>
    `;
  }).join('');
}

function renderClimateRows(devices) {
  if (!devices.length) return emptyRow(5);
  return devices.map(d => {
    const s = d.last_state || {};
    const temp = s.currentTempF != null ? `${Math.round(s.currentTempF)}°F` : '—';
    const humidity = s.humidity != null ? `${s.humidity}%` : '—';
    const mode = s.mode || '—';
    const hvac = s.hvacStatus || 'OFF';
    const online = s.connectivity === 'ONLINE';
    return `
      <tr>
        <td class="dt-name">${statusDot(online)} ${esc(d.room_name)}</td>
        <td class="dt-num">${temp}</td>
        <td class="dt-num">${humidity}</td>
        <td>${esc(mode)}</td>
        <td>${hvac === 'HEATING' ? '🔥' : hvac === 'COOLING' ? '❄️' : '—'} ${esc(hvac)}</td>
      </tr>
    `;
  }).join('');
}

function renderVehicleRows(vehicles) {
  if (!vehicles.length) return emptyRow(7);
  return vehicles.map(v => {
    const s = v.last_state || {};
    const battery = s.battery_level != null ? `${s.battery_level}%` : '—';
    const status = v.vehicle_state || '—';
    const locked = s.locked != null ? (s.locked ? '🔒' : '🔓') : '—';

    // Onsite check: compare vehicle GPS to property GPS
    let onsiteHtml = '<span class="dt-secondary">—</span>';
    if (propertyGps && s.latitude != null && s.longitude != null) {
      const dist = distanceMeters(s.latitude, s.longitude, propertyGps.lat, propertyGps.lng);
      if (dist <= ONSITE_RADIUS_M) {
        onsiteHtml = '<span class="dt-badge dt-badge--green">YES</span>';
      } else {
        onsiteHtml = '<span class="dt-secondary">No</span>';
      }
    }

    return `
      <tr>
        <td class="dt-name">${esc(v.name)}</td>
        <td class="dt-secondary">${esc(v.vehicle_make)} ${esc(v.vehicle_model)} ${v.year || ''}</td>
        <td class="dt-num">${battery}</td>
        <td>${esc(status)}</td>
        <td>${locked}</td>
        <td>${onsiteHtml}</td>
        <td class="dt-secondary">${timeAgo(v.last_synced_at)}</td>
      </tr>
    `;
  }).join('');
}

function renderLaundryRows(appliances) {
  if (!appliances.length) return emptyRow(4, 'No appliances configured');
  return appliances.map(a => {
    const s = a.last_state || {};
    const state = s.currentState || 'UNKNOWN';
    const remaining = (s.remainHour || s.remainMinute)
      ? `${s.remainHour ? s.remainHour + 'h ' : ''}${s.remainMinute || 0}m`
      : '—';
    return `
      <tr>
        <td class="dt-name">${esc(a.name)}</td>
        <td>${esc(a.device_type)}</td>
        <td>${esc(state)}</td>
        <td class="dt-num">${remaining}</td>
      </tr>
    `;
  }).join('');
}

function renderAlexaRows(devices) {
  if (!devices.length) return emptyRow(6, 'No Alexa/Amazon clients detected');
  return devices.map(d => {
    const label = d.name || d.hostname || (d._fallback ? 'Amazon device (name unavailable)' : 'Unnamed device');
    const conn = d.is_wired ? 'Wired' : 'WiFi';
    const lastSeen = d._fallback
      ? 'Snapshot'
      : (d.last_seen ? timeAgo(new Date(d.last_seen * 1000).toISOString()) : '—');
    return `
      <tr>
        <td class="dt-name">${esc(label)}</td>
        <td class="dt-secondary">${esc(d.hostname || '—')}</td>
        <td>${esc(d.ip || '—')}</td>
        <td class="dt-secondary">${esc(d.oui || '—')}</td>
        <td>${esc(conn)}</td>
        <td class="dt-secondary" title="${esc(d._fallbackLabel || '')}">${esc(lastSeen)}</td>
      </tr>
    `;
  }).join('');
}

function emptyRow(cols, msg = 'No devices') {
  return `<tr><td colspan="${cols}" class="dt-empty">${msg}</td></tr>`;
}

/* ── Section Builder ── */

function buildSection(cat, count, theadHtml, tbodyHtml) {
  const collapsed = getCollapsed();
  const isOpen = !collapsed.includes(cat.id);
  return `
    <details class="device-section" ${isOpen ? 'open' : ''} data-section="${cat.id}">
      <summary class="device-section__header">
        <span class="device-section__chevron"></span>
        <span class="device-section__label">${cat.label}</span>
        <a href="${cat.href}" class="device-section__link" onclick="event.stopPropagation()">${cat.linkLabel} →</a>
        <span class="device-section__count">${count}</span>
      </summary>
      <div class="device-section__body">
        <div class="device-table-wrap">
          <table class="device-table">
            <thead><tr>${theadHtml}</tr></thead>
            <tbody>${tbodyHtml}</tbody>
          </table>
        </div>
      </div>
    </details>
  `;
}

function th(label) { return `<th>${label}</th>`; }

/* ── Collapse Persistence ── */

function getCollapsed() {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'); } catch { return []; }
}

function saveCollapsed(list) {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify(list));
}

function initCollapseListeners(container) {
  container.querySelectorAll('.device-section').forEach(det => {
    det.addEventListener('toggle', () => {
      const id = det.dataset.section;
      let collapsed = getCollapsed();
      if (det.open) {
        collapsed = collapsed.filter(c => c !== id);
      } else {
        if (!collapsed.includes(id)) collapsed.push(id);
      }
      saveCollapsed(collapsed);
    });
  });
}

/* ── Main ── */

document.addEventListener('DOMContentLoaded', async () => {
  await initResidentPage({
    activeTab: 'devices',
    requiredRole: 'resident',
    onReady: (state) => {
      renderInventory(state);
    },
  });
});

async function renderInventory() {
  const container = document.getElementById('devicesGrid');
  if (!container) return;
  container.innerHTML = '<p class="text-muted" style="padding:1rem">Loading devices...</p>';

  let cameras, lighting, sonos, climate, vehicles, laundry, alexa;
  try {
    [cameras, lighting, sonos, climate, vehicles, laundry, alexa] = await Promise.all([
      fetchCameras(),
      fetchLighting(),
      fetchSonos(),
      fetchClimate(),
      fetchVehicles(),
      fetchLaundry(),
      fetchAlexaClients(),
      fetchPropertyGps(),
    ]);
  } catch (e) {
    console.error('Device inventory fetch error:', e);
    container.innerHTML = '<p class="text-muted" style="padding:1rem">Error loading devices. Check console.</p>';
    return;
  }

  const totalDevices = cameras.length
    + lighting.reduce((s, g) => s + g.deviceCount, 0)
    + sonos.length
    + climate.length
    + vehicles.length
    + laundry.length
    + alexa.length;

  // Populate inline meta count in section header
  const metaEl = document.getElementById('devicesMeta');
  if (metaEl) metaEl.textContent = `${totalDevices} in ${CATEGORIES.length} categories`;

  let html = '';

  // Cameras
  const camCat = CATEGORIES.find(c => c.id === 'cameras');
  html += buildSection(camCat, cameras.length,
    th('Camera') + th('Location') + th('Type') + th('Qualities'),
    renderCameraRows(cameras));

  // Lighting (groups)
  const lightCat = CATEGORIES.find(c => c.id === 'lighting');
  const totalLights = lighting.reduce((s, g) => s + g.deviceCount, 0);
  html += buildSection(lightCat, `${lighting.length} groups · ${totalLights} devices`,
    th('Group') + th('Area') + th('Devices') + th('Models'),
    renderLightingRows(lighting));

  // Music (Sonos)
  const musicCat = CATEGORIES.find(c => c.id === 'music');
  const playingCount = sonos.filter(z => z.playbackState === 'PLAYING').length;
  const sonosCount = playingCount > 0 ? `${sonos.length} zones · ${playingCount} playing` : `${sonos.length} zones`;
  html += buildSection(musicCat, sonosCount,
    th('Zone') + th('State') + th('Now Playing') + th('Volume'),
    renderSonosRows(sonos));

  // Climate
  const climateCat = CATEGORIES.find(c => c.id === 'climate');
  html += buildSection(climateCat, climate.length,
    th('Room') + th('Temp') + th('Humidity') + th('Mode') + th('HVAC'),
    renderClimateRows(climate));

  // Vehicles
  const carCat = CATEGORIES.find(c => c.id === 'cars');
  html += buildSection(carCat, vehicles.length,
    th('Name') + th('Vehicle') + th('Battery') + th('Status') + th('Lock') + th('Onsite') + th('Synced'),
    renderVehicleRows(vehicles));

  // Laundry
  const laundryCat = CATEGORIES.find(c => c.id === 'laundry');
  html += buildSection(laundryCat, laundry.length,
    th('Name') + th('Type') + th('State') + th('Remaining'),
    renderLaundryRows(laundry));

  // Alexa / Amazon clients discovered from UDM Pro client list
  const alexaCat = CATEGORIES.find(c => c.id === 'alexa');
  html += buildSection(alexaCat, alexa.length,
    th('Device') + th('Hostname') + th('IP') + th('Vendor') + th('Connection') + th('Last Seen'),
    renderAlexaRows(alexa));

  container.innerHTML = html;
  initCollapseListeners(container);
}
