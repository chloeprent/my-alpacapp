/**
 * Sensors Page — Full-screen immersive UP-SENSE dashboard.
 * SVG arc gauges, live polling, dark theme with gradient accents.
 * Shows last-known data even when BLE connection is intermittent.
 */

import { initResidentPage } from '../shared/resident-shell.js';
import { supabase } from '../shared/supabase.js';

const SENSORS_PROXY = 'https://YOUR_CAMERA_PROXY/sensors';
const SONOS_PROXY = 'https://YOUR_CAMERA_PROXY/sonos';
const POLL_INTERVAL = 30000;
const GREETING_COOLDOWN = 15 * 60 * 1000; // 15 min between greetings

let sensors = [];
let lastPollTime = null;
let prevDoorStates = {};      // sensorId → boolean (was open)
let lastGreetingTime = 0;     // timestamp of last greeting

document.addEventListener('DOMContentLoaded', async () => {
  await initResidentPage({
    activeTab: 'sensors',
    requiredRole: 'resident',
    onReady: async () => {
      await loadSensors();
      render();
      startPolling();
    },
  });
});

// =============================================
// DATA
// =============================================

async function loadSensors() {
  const { data, error } = await supabase
    .from('protect_sensors')
    .select('*')
    .eq('is_active', true)
    .order('display_order');

  if (error || !data?.length) { sensors = []; return; }

  const states = await fetchSensorStates();
  sensors = data.map(meta => {
    const state = states.find(s => s.id === meta.protect_sensor_id) || null;
    // Seed door state so first poll doesn't trigger a false greeting
    if (state) prevDoorStates[meta.protect_sensor_id] = state.isOpened ?? false;
    return { meta, state };
  });
}

async function fetchSensorStates() {
  try {
    const resp = await fetch(SENSORS_PROXY);
    if (!resp.ok) throw new Error(resp.status);
    lastPollTime = new Date();
    return await resp.json();
  } catch (err) {
    console.warn('Sensor fetch failed:', err.message);
    return [];
  }
}

async function refreshStates() {
  if (!sensors.length) return;
  const states = await fetchSensorStates();
  for (const s of sensors) {
    const live = states.find(st => st.id === s.meta.protect_sensor_id);
    if (live) {
      checkDoorTransition(s.meta, s.state, live);
      s.state = live;
    }
  }
}

// Detect door closed→open and play Sonos greeting
function checkDoorTransition(meta, oldState, newState) {
  if (meta.mount_type !== 'door' && meta.mount_type !== 'window') return;
  const id = meta.protect_sensor_id;
  const wasOpen = prevDoorStates[id] ?? oldState?.isOpened ?? false;
  const isOpen = newState.isOpened;
  prevDoorStates[id] = isOpen;

  // Trigger on closed→open transition only
  if (!wasOpen && isOpen) {
    const now = Date.now();
    if (now - lastGreetingTime < GREETING_COOLDOWN) {
      console.log('[Greeting] Cooldown active, skipping');
      return;
    }
    lastGreetingTime = now;
    playGarageGreeting(meta.location || meta.name);
  }
}

async function playGarageGreeting(location) {
  console.log(`[Greeting] Door opened at ${location} — playing announcement on DJ`);
  try {
    await fetch(`${SONOS_PROXY}/DJ/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Welcome to the Garage Mahal',
        lang: 'en-us',
        volume: 40,
      }),
    });
  } catch (err) {
    console.warn('[Greeting] Failed:', err.message);
  }
}

function startPolling() {
  if (!sensors.length) return;
  setInterval(async () => {
    if (document.hidden) return;
    await refreshStates();
    render();
  }, POLL_INTERVAL);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && sensors.length) refreshStates().then(render);
  });
}

// =============================================
// HELPERS
// =============================================

function toF(c) {
  if (c == null) return null;
  return (c * 9 / 5) + 32;
}

function tempLabel(f) {
  if (f == null) return 'No data';
  if (f < 50) return 'Cold';
  if (f < 65) return 'Cool';
  if (f < 75) return 'Comfortable';
  if (f < 85) return 'Warm';
  return 'Hot';
}

function tempColor(f) {
  if (f == null) return '#64748b';
  if (f < 50) return '#38bdf8';
  if (f < 65) return '#67e8f9';
  if (f < 75) return '#fbbf24';
  if (f < 85) return '#f59e0b';
  return '#ef4444';
}

function humidityLabel(h) {
  if (h == null) return 'No data';
  if (h < 25) return 'Very dry';
  if (h < 40) return 'Dry';
  if (h < 60) return 'Comfortable';
  if (h < 75) return 'Humid';
  return 'Very humid';
}

function timeAgo(ts) {
  if (!ts) return '';
  const ms = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function arcPath(pct, r, cx, cy) {
  const clamp = Math.max(0, Math.min(1, pct));
  const startAngle = Math.PI;
  const endAngle = Math.PI + clamp * Math.PI;
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy + r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy + r * Math.sin(endAngle);
  const large = clamp > 0.5 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// =============================================
// RENDERING
// =============================================

function render() {
  const grid = document.getElementById('sensorsGrid');
  const empty = document.getElementById('sensorsEmpty');
  const meta = document.getElementById('sensorsMeta');

  if (!sensors.length) {
    if (grid) grid.innerHTML = '';
    if (empty) empty.style.display = '';
    if (meta) meta.textContent = '';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (meta) meta.textContent = '';
  if (grid) grid.innerHTML = sensors.map(renderDashboard).join('');
}

function renderDashboard({ meta, state }) {
  const hasData = state != null;
  const isConnected = state?.isConnected === true;
  const tempC = state?.stats?.temperature?.value ?? null;
  const tempFVal = toF(tempC);
  const tempStr = tempFVal != null ? tempFVal.toFixed(1) : '--';
  const hum = state?.stats?.humidity?.value ?? null;
  const humStr = hum != null ? Math.round(hum) : '--';
  const lux = state?.stats?.light?.value ?? null;
  const luxStr = lux != null ? Math.round(lux) : '--';
  const battPct = state?.batteryStatus?.percentage ?? null;
  const battLow = state?.batteryStatus?.isLow;
  const isOpen = state?.isOpened;
  const isMotion = state?.isMotionDetected;
  const showDoor = meta.mount_type === 'door' || meta.mount_type === 'window' || isOpen != null;
  const hasAlarm = state?.alarmTriggeredAt &&
    (Date.now() - new Date(state.alarmTriggeredAt).getTime()) < 300000;
  const fw = state?.firmwareVersion || '';

  // Gauge params
  const cx = 70, cy = 60, r = 50;
  const humPct = hum != null ? hum / 100 : 0;
  const luxPct = lux != null ? Math.min(1, Math.log10(Math.max(1, lux)) / 3) : 0;

  return `
  <div class="sdash">
    <div class="sdash__inner">
      <!-- Header -->
      <div class="sdash__head">
        <div class="sdash__dot ${isConnected ? 'sdash__dot--live' : 'sdash__dot--off'}"></div>
        <span class="sdash__name">${esc(meta.name)}</span>
        ${meta.location ? `<span class="sdash__loc">${esc(meta.location)}</span>` : ''}
        <span class="sdash__conn-badge ${isConnected ? 'sdash__conn-badge--live' : 'sdash__conn-badge--off'}">
          ${isConnected ? 'Connected' : hasData ? 'Last Known' : 'No Data'}
        </span>
        <span class="sdash__batt ${battLow ? 'sdash__batt--low' : 'sdash__batt--ok'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="1" y="6" width="18" height="12" rx="2" ry="2"/>
            <line x1="23" y1="13" x2="23" y2="11"/>
            ${battPct != null ? `<rect x="3" y="8" width="${Math.max(1, battPct / 100 * 14)}" height="8" rx="1" fill="currentColor" stroke="none"/>` : ''}
          </svg>
          ${battPct != null ? battPct + '%' : '--'}
        </span>
      </div>

      ${hasAlarm ? `
      <div class="sdash__alarm">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        ALARM TRIGGERED
      </div>` : ''}

      <!-- Top row: Temperature + Gauges side by side on desktop -->
      <div class="sdash__top">
        <!-- Temperature Hero -->
        <div class="sdash__temp-hero">
          <div class="sdash__temp-label">Temperature</div>
          <div class="sdash__temp-val">
            ${tempStr}<span class="sdash__temp-unit">&deg;F</span>
          </div>
          <div class="sdash__temp-status" style="color:${tempColor(tempFVal)}">${tempLabel(tempFVal)}</div>
        </div>

        <!-- Gauges: Humidity + Light -->
        <div class="sdash__gauges">
          <div class="sdash__gauge">
            <div class="sdash__gauge-label">Humidity</div>
            <svg width="140" height="80" viewBox="0 140 140 80">
              <path d="${arcPath(1, r, cx, cy)}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="10" stroke-linecap="round"/>
              <path d="${arcPath(humPct, r, cx, cy)}" fill="none" stroke="url(#humGrad)" stroke-width="10" stroke-linecap="round"/>
              <defs><linearGradient id="humGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#22d3ee"/>
              </linearGradient></defs>
            </svg>
            <div class="sdash__gauge-val" style="color:#22d3ee">${humStr}<span class="sdash__gauge-unit">%</span></div>
            <div class="sdash__gauge-sub">${humidityLabel(hum)}</div>
          </div>
          <div class="sdash__gauge">
            <div class="sdash__gauge-label">Light</div>
            <svg width="140" height="80" viewBox="0 140 140 80">
              <path d="${arcPath(1, r, cx, cy)}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="10" stroke-linecap="round"/>
              <path d="${arcPath(luxPct, r, cx, cy)}" fill="none" stroke="url(#luxGrad)" stroke-width="10" stroke-linecap="round"/>
              <defs><linearGradient id="luxGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#fbbf24"/>
              </linearGradient></defs>
            </svg>
            <div class="sdash__gauge-val" style="color:#fbbf24">${luxStr}<span class="sdash__gauge-unit"> lux</span></div>
            <div class="sdash__gauge-sub">${lux == null ? 'No data' : lux < 10 ? 'Dark' : lux < 200 ? 'Dim' : lux < 500 ? 'Moderate' : 'Bright'}</div>
          </div>
        </div>
      </div>

      <!-- Door + Motion Statuses -->
      <div class="sdash__statuses">
        ${showDoor ? `
        <div class="sdash__status sdash__status--${isOpen ? 'open' : 'closed'}">
          <div class="sdash__status-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              ${isOpen
                ? '<path d="M5 2h11a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M12 2l5 4v12l-5 4V2z" fill="currentColor" opacity="0.2"/><circle cx="9" cy="12" r="1"/>'
                : '<path d="M5 2h11a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><circle cx="14" cy="12" r="1"/><path d="M3 22V2"/>'
              }
            </svg>
          </div>
          <div class="sdash__status-label">Door</div>
          <div class="sdash__status-val">${isOpen ? 'OPEN' : 'CLOSED'}</div>
          ${state?.openStatusChangedAt ? `<div class="sdash__status-time">${timeAgo(state.openStatusChangedAt)}</div>` : ''}
        </div>` : ''}

        <div class="sdash__status sdash__status--${isMotion ? 'motion' : 'clear'}">
          <div class="sdash__status-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              ${isMotion
                ? '<circle cx="12" cy="5" r="2"/><path d="M10 22V13l-3-3 1-4 6 1 3 3"/><path d="M17 18l-3-3"/><path d="M7 13l-3 5"/>'
                : '<circle cx="12" cy="12" r="3" opacity="0.3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" opacity="0.2"/>'
              }
            </svg>
          </div>
          <div class="sdash__status-label">Motion</div>
          <div class="sdash__status-val">${isMotion ? 'DETECTED' : 'CLEAR'}</div>
          ${state?.motionDetectedAt ? `<div class="sdash__status-time">${timeAgo(state.motionDetectedAt)}</div>` : ''}
        </div>
      </div>

      <!-- Footer -->
      <div class="sdash__footer">
        <span>Model: ${esc(state?.type || 'UP-SENSE')}</span>
        ${fw ? `<span>FW: ${esc(fw)}</span>` : ''}
        ${state?.mac ? `<span>MAC: ${esc(state.mac)}</span>` : ''}
        ${lastPollTime ? `<span>Updated: ${lastPollTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>` : ''}
      </div>
    </div>
  </div>`;
}
