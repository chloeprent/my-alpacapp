/**
 * Climate / Thermostat Page
 * Shows Nest thermostats with current state, target temp controls, mode, and eco toggle.
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../shared/supabase.js';
import { initResidentPage, showToast } from '../shared/resident-shell.js';
import { hasPermission } from '../shared/auth.js';
import { getResidentDeviceScope } from '../shared/services/resident-device-scope.js';
import { PollManager } from '../shared/services/poll-manager.js';
import { supabaseHealth } from '../shared/supabase-health.js';

// =============================================
// CONFIGURATION
// =============================================
const NEST_CONTROL_URL = `${SUPABASE_URL}/functions/v1/nest-control`;
const POLL_INTERVAL_MS = 30000;
const NEST_OAUTH_REDIRECT_URI = 'https://YOUR_DOMAIN/residents/climate.html';

// =============================================
// STATE
// =============================================
let thermostats = [];
let poll = null;
let lastPollTime = null;
let lastContactTimes = {}; // { sdmDeviceId: Date } — last successful state fetch
let currentUserRole = null;
let deviceScope = null;

// =============================================
// INITIALIZATION
// =============================================
document.addEventListener('DOMContentLoaded', async () => {
  await initResidentPage({
    activeTab: 'devices',
    requiredRole: 'resident',
    onReady: async (authState) => {
      currentUserRole = authState.appUser?.role;
      deviceScope = await getResidentDeviceScope(authState.appUser, authState.hasPermission);

      // Check for OAuth callback code in URL params
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      if (code) {
        // Always clean the URL to avoid reuse
        window.history.replaceState({}, '', window.location.pathname);
        if (hasPermission('admin_climate_settings')) {
          await handleOAuthCallback(code);
        } else {
          console.warn('OAuth code present but user lacks admin_climate_settings permission');
        }
      }

      // Load weather and thermostats in parallel
      await Promise.all([
        loadWeatherForecast(),
        loadThermostats(),
      ]);
      renderThermostats();
      setupEventListeners();
      startPolling();
      // Refresh when PAI changes thermostat settings
      window.addEventListener('pai-actions', (e) => {
        const thermoActions = (e.detail?.actions || []).filter(a => a.type === 'control_thermostat');
        if (thermoActions.length) setTimeout(() => refreshAllStates(), 1500);
      });

      if (hasPermission('admin_climate_settings')) {
        await loadNestSettings();
      }
    },
  });
});

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
  if (!token) {
    showToast('Session expired. Please refresh.', 'error');
    throw new Error('No auth token');
  }

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
async function loadThermostats() {
  try {
    const { data, error } = await supabase
      .from('nest_devices')
      .select('*')
      .eq('is_active', true)
      .eq('device_type', 'thermostat')
      .order('display_order', { ascending: true });

    if (error) throw error;

    thermostats = (data || []).map(d => {
      // Seed last contact from DB updated_at so timestamp shows before first API poll
      if (d.updated_at && d.last_state) {
        lastContactTimes[d.sdm_device_id] = new Date(d.updated_at);
      }
      return {
        id: d.id,
        sdmDeviceId: d.sdm_device_id,
        roomName: d.room_name,
        displayOrder: d.display_order,
        lanIp: d.lan_ip,
        spaceId: d.space_id,
        state: d.last_state || null,
      };
    });

    if (deviceScope && !deviceScope.fullAccess) {
      thermostats = thermostats.filter((t) =>
        deviceScope.canAccessSpaceId(t.spaceId) || deviceScope.canAccessSpaceName(t.roomName)
      );
    }
  } catch (err) {
    console.error('Failed to load thermostats:', err);
    showToast('Failed to load thermostats', 'error');
  }
}

async function refreshAllStates() {
  if (!thermostats.length) return;

  try {
    const result = await nestApi('getAllStates');
    if (result.devices) {
      for (const device of result.devices) {
        if (device.error) continue;
        const t = thermostats.find(th => th.sdmDeviceId === device.deviceId);
        if (t && device.state) {
          t.state = device.state;
          lastContactTimes[t.sdmDeviceId] = new Date();
          updateThermostatUI(t.sdmDeviceId);
        }
      }
    }
    supabaseHealth.recordSuccess();
  } catch (err) {
    console.warn('State refresh failed:', err.message);
    supabaseHealth.recordFailure();
    throw err; // let PollManager circuit breaker track failures
  }

  lastPollTime = new Date();
  updatePollStatus();
}

async function refreshDeviceState(sdmDeviceId) {
  try {
    const state = await nestApi('getDeviceState', { deviceId: sdmDeviceId });
    const t = thermostats.find(th => th.sdmDeviceId === sdmDeviceId);
    if (t && state) {
      t.state = state;
      lastContactTimes[sdmDeviceId] = new Date();
      updateThermostatUI(sdmDeviceId);
    }
  } catch (err) {
    console.warn(`State refresh failed for ${sdmDeviceId}:`, err.message);
  }
}

// =============================================
// LAST CONTACT HELPERS
// =============================================
function formatLastContact(deviceId) {
  const t = lastContactTimes[deviceId];
  if (!t) return '';
  const diff = Date.now() - t.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return t.toLocaleDateString();
}

// =============================================
// RENDERING
// =============================================
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderThermostats() {
  const container = document.getElementById('thermostatGrid');
  if (!container) return;

  if (!thermostats.length) {
    container.innerHTML = '<p class="text-muted" style="padding: 2rem; text-align: center;">No thermostats configured.</p>';
    return;
  }

  container.innerHTML = thermostats.map(t => renderCard(t)).join('');
}

function renderCard(t) {
  const s = t.state || {};
  const deviceAttr = escapeHtml(t.sdmDeviceId);
  const isOnline = s.connectivity === 'ONLINE';
  const isHeating = s.hvacStatus === 'HEATING';
  const isCooling = s.hvacStatus === 'COOLING';
  const isEco = s.ecoMode === 'MANUAL_ECO';

  // Target temp display (include OFF so we show stored setpoints when available)
  let targetDisplay = '--';
  if (s.mode === 'HEAT' && s.heatSetpointF != null) {
    targetDisplay = `${s.heatSetpointF}`;
  } else if (s.mode === 'COOL' && s.coolSetpointF != null) {
    targetDisplay = `${s.coolSetpointF}`;
  } else if (s.mode === 'HEATCOOL' || (s.mode === 'OFF' && (s.heatSetpointF != null || s.coolSetpointF != null))) {
    const heat = s.heatSetpointF != null ? `${s.heatSetpointF}` : '--';
    const cool = s.coolSetpointF != null ? `${s.coolSetpointF}` : '--';
    targetDisplay = heat === cool ? heat : `${heat} - ${cool}`;
    if (s.mode === 'OFF') targetDisplay += ' (Off)';
  } else if (s.mode === 'OFF') {
    targetDisplay = 'Off';
  }

  // HVAC badge
  let hvacClass = 'hvac-off';
  let hvacLabel = 'Idle';
  if (isHeating) { hvacClass = 'hvac-heating'; hvacLabel = 'Heating'; }
  else if (isCooling) { hvacClass = 'hvac-cooling'; hvacLabel = 'Cooling'; }

  // Card classes
  const cardClasses = [
    'thermostat-card',
    isHeating ? 'heating' : '',
    isCooling ? 'cooling' : '',
    !isOnline && s.connectivity ? 'disconnected' : '',
  ].filter(Boolean).join(' ');

  return `
    <div class="${cardClasses}" data-device="${deviceAttr}">
      <div class="thermostat-card__header">
        <span class="thermostat-card__name">${escapeHtml(t.roomName)}</span>
        ${s.connectivity ? `<span class="status-dot ${isOnline ? 'status-live' : 'status-offline'}" title="${isOnline ? 'Online' : 'Offline'}"></span>` : ''}
        ${lastContactTimes[t.sdmDeviceId] ? `<span class="thermostat-card__last-contact">${formatLastContact(t.sdmDeviceId)}</span>` : ''}
      </div>

      <div class="thermostat-card__current">
        <span class="thermostat-card__temp-value">${s.currentTempF != null ? s.currentTempF : '--'}</span>
        <span class="thermostat-card__temp-unit">&deg;F</span>
        ${s.humidity != null ? `<span class="thermostat-card__humidity">${s.humidity}%</span>` : ''}
      </div>

      <div class="thermostat-card__badges">
        <span class="thermostat-badge ${hvacClass}">${hvacLabel}</span>
        ${isEco ? '<span class="thermostat-badge eco-badge">Eco</span>' : ''}
        ${s.mode ? `<span class="thermostat-badge hvac-off">${escapeHtml(formatMode(s.mode))}</span>` : ''}
      </div>

      <div class="thermostat-card__target">
        <span class="thermostat-card__target-label">Target</span>
        <div class="thermostat-card__target-controls">
          <button class="thermostat-btn" data-action="tempDown" data-device="${deviceAttr}" ${s.mode === 'OFF' ? 'disabled' : ''}>&#8722;</button>
          <span class="thermostat-card__target-value">${targetDisplay === 'Off' ? targetDisplay : `${targetDisplay}&deg;F`}</span>
          <button class="thermostat-btn" data-action="tempUp" data-device="${deviceAttr}" ${s.mode === 'OFF' ? 'disabled' : ''}>+</button>
        </div>
      </div>

      <div class="thermostat-card__mode">
        <select data-action="setMode" data-device="${deviceAttr}">
          <option value="HEAT" ${s.mode === 'HEAT' ? 'selected' : ''}>Heat</option>
          <option value="COOL" ${s.mode === 'COOL' ? 'selected' : ''}>Cool</option>
          <option value="HEATCOOL" ${s.mode === 'HEATCOOL' ? 'selected' : ''}>Heat/Cool</option>
          <option value="OFF" ${s.mode === 'OFF' ? 'selected' : ''}>Off</option>
        </select>
        <button class="thermostat-eco-btn ${isEco ? 'active' : ''}"
                data-action="toggleEco" data-device="${deviceAttr}"
                title="${isEco ? 'Disable Eco' : 'Enable Eco'}">
          Eco
        </button>
      </div>
    </div>
  `;
}

function formatMode(mode) {
  const labels = { HEAT: 'Heat', COOL: 'Cool', HEATCOOL: 'Heat/Cool', OFF: 'Off' };
  return labels[mode] || mode;
}

function updateThermostatUI(sdmDeviceId) {
  const t = thermostats.find(th => th.sdmDeviceId === sdmDeviceId);
  if (!t) return;
  const card = document.querySelector(`[data-device="${CSS.escape(sdmDeviceId)}"]`);
  if (!card) return;
  card.outerHTML = renderCard(t);
}

function updatePollStatus() {
  const el = document.getElementById('pollStatus');
  if (!el || !lastPollTime) return;
  const timeStr = lastPollTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.textContent = `Last updated: ${timeStr}`;
}

// =============================================
// CONTROLS
// =============================================
async function setTemperature(sdmDeviceId, direction) {
  const t = thermostats.find(th => th.sdmDeviceId === sdmDeviceId);
  if (!t?.state || t.state.mode === 'OFF') return;

  const card = document.querySelector(`[data-device="${CSS.escape(sdmDeviceId)}"]`);
  card?.classList.add('loading');

  try {
    const s = t.state;
    const delta = direction === 'up' ? 1 : -1;

    if (s.mode === 'HEATCOOL') {
      await nestApi('setTemperature', {
        deviceId: sdmDeviceId,
        heatTemp: s.heatSetpointF + delta,
        coolTemp: s.coolSetpointF + delta,
      });
    } else if (s.mode === 'COOL') {
      await nestApi('setTemperature', {
        deviceId: sdmDeviceId,
        temperature: s.coolSetpointF + delta,
      });
    } else {
      await nestApi('setTemperature', {
        deviceId: sdmDeviceId,
        temperature: s.heatSetpointF + delta,
      });
    }

    showToast(`Temperature adjusted`, 'success', 2000);
    setTimeout(() => refreshDeviceState(sdmDeviceId), 1500);
  } catch (err) {
    showToast(`Temperature failed: ${err.message}`, 'error');
  } finally {
    card?.classList.remove('loading');
  }
}

async function setMode(sdmDeviceId, mode) {
  const card = document.querySelector(`[data-device="${CSS.escape(sdmDeviceId)}"]`);
  card?.classList.add('loading');

  try {
    await nestApi('setMode', { deviceId: sdmDeviceId, mode });
    showToast(`Mode set to ${formatMode(mode)}`, 'success', 2000);
    setTimeout(() => refreshDeviceState(sdmDeviceId), 1500);
  } catch (err) {
    showToast(`Mode change failed: ${err.message}`, 'error');
  } finally {
    card?.classList.remove('loading');
  }
}

async function toggleEco(sdmDeviceId) {
  const t = thermostats.find(th => th.sdmDeviceId === sdmDeviceId);
  const currentEco = t?.state?.ecoMode;
  const newEco = currentEco === 'MANUAL_ECO' ? 'OFF' : 'MANUAL_ECO';

  const card = document.querySelector(`[data-device="${CSS.escape(sdmDeviceId)}"]`);
  card?.classList.add('loading');

  try {
    await nestApi('setEco', { deviceId: sdmDeviceId, ecoMode: newEco });
    showToast(`Eco ${newEco === 'MANUAL_ECO' ? 'enabled' : 'disabled'}`, 'success', 2000);
    setTimeout(() => refreshDeviceState(sdmDeviceId), 1500);
  } catch (err) {
    showToast(`Eco toggle failed: ${err.message}`, 'error');
  } finally {
    card?.classList.remove('loading');
  }
}

// =============================================
// POLLING
// =============================================
function startPolling() {
  if (poll) poll.stop();
  poll = new PollManager(refreshAllStates, POLL_INTERVAL_MS);
  poll.start();
}

// =============================================
// EVENT LISTENERS
// =============================================
function setupEventListeners() {
  // Refresh button
  document.getElementById('refreshBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('refreshBtn');
    btn.disabled = true;
    btn.textContent = 'Refreshing...';
    await refreshAllStates();
    btn.disabled = false;
    btn.textContent = 'Refresh';
  });

  // Event delegation on thermostat grid
  const grid = document.getElementById('thermostatGrid');
  if (grid) {
    // Click events (buttons)
    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      const deviceId = btn.dataset.device;

      if (action === 'tempUp') {
        setTemperature(deviceId, 'up');
      } else if (action === 'tempDown') {
        setTemperature(deviceId, 'down');
      } else if (action === 'toggleEco') {
        toggleEco(deviceId);
      }
    });

    // Change events (select dropdowns)
    grid.addEventListener('change', (e) => {
      const select = e.target.closest('[data-action="setMode"]');
      if (!select) return;
      setMode(select.dataset.device, select.value);
    });
  }

  // Admin: Test mode toggle
  document.getElementById('nestTestMode')?.addEventListener('change', async (e) => {
    const testMode = e.target.checked;
    try {
      await supabase.from('nest_config').update({ test_mode: testMode }).eq('id', 1);
      const badge = document.getElementById('nestModeBadge');
      if (badge) badge.textContent = testMode ? 'Test Mode' : 'Live';
      showToast(`Nest ${testMode ? 'test' : 'live'} mode enabled`, 'success');
    } catch (err) {
      showToast('Failed to update test mode', 'error');
      e.target.checked = !testMode;
    }
  });

  // Admin: Start OAuth flow
  document.getElementById('startOAuthBtn')?.addEventListener('click', startOAuthFlow);

  // Admin: Discover devices
  document.getElementById('discoverDevicesBtn')?.addEventListener('click', discoverDevices);
}

// =============================================
// ADMIN: SETTINGS
// =============================================
async function loadNestSettings() {
  try {
    const { data: config } = await supabase
      .from('nest_config')
      .select('test_mode, refresh_token, token_expires_at, google_client_id, sdm_project_id')
      .single();

    if (!config) return;

    // Test mode toggle
    const toggle = document.getElementById('nestTestMode');
    if (toggle) toggle.checked = config.test_mode || false;

    const badge = document.getElementById('nestModeBadge');
    if (badge) badge.textContent = config.test_mode ? 'Test Mode' : 'Live';

    // Show OAuth setup only if no refresh token (access token auto-refreshes)
    const oauthSection = document.getElementById('oauthSetupSection');
    const deviceSection = document.getElementById('deviceManagementSection');
    const needsAuth = !config.refresh_token;
    if (needsAuth) {
      oauthSection?.classList.remove('hidden');
      deviceSection?.classList.add('hidden');
    } else {
      oauthSection?.classList.add('hidden');
      deviceSection?.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Failed to load nest settings:', err);
  }
}

// =============================================
// ADMIN: OAUTH FLOW
// =============================================
async function startOAuthFlow() {
  try {
    const { data: config } = await supabase
      .from('nest_config')
      .select('google_client_id, sdm_project_id')
      .single();

    if (!config?.google_client_id || !config?.sdm_project_id) {
      showToast('Google client ID and SDM project ID must be configured first', 'error');
      return;
    }

    const redirectUri = NEST_OAUTH_REDIRECT_URI;
    const authUrl = `https://nestservices.google.com/partnerconnections/${config.sdm_project_id}/auth?` +
      `redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&access_type=offline` +
      `&prompt=consent` +
      `&client_id=${config.google_client_id}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent('https://www.googleapis.com/auth/sdm.service')}`;

    // Same-tab redirect so the callback code is captured reliably
    window.location.href = authUrl;
  } catch (err) {
    showToast(`OAuth setup failed: ${err.message}`, 'error');
  }
}

async function handleOAuthCallback(code) {
  try {
    showToast('Completing Google authorization...', 'info', 5000);
    const redirectUri = NEST_OAUTH_REDIRECT_URI;
    await nestApi('oauthCallback', { code, redirectUri });
    showToast('Google Nest authorized successfully!', 'success');
  } catch (err) {
    showToast(`OAuth failed: ${err.message}`, 'error');
  }
}

// =============================================
// ADMIN: DEVICE DISCOVERY
// =============================================
// =============================================
// WEATHER FORECAST (OpenWeatherMap One Call API)
// =============================================
let weatherData = null;

async function loadWeatherForecast() {
  try {
    const { data: config } = await supabase
      .from('weather_config')
      .select('owm_api_key, latitude, longitude, location_name, is_active')
      .single();

    if (!config?.is_active || !config?.owm_api_key) {
      const summary = document.getElementById('rainSummary');
      if (summary) {
        summary.innerHTML = '<p class="text-muted" style="font-size: 0.85rem;">Weather API not configured. Admin: add OpenWeatherMap API key to weather_config.</p>';
      }
      return;
    }

    // Show location name
    const locEl = document.getElementById('weatherLocation');
    if (locEl) locEl.textContent = config.location_name || '';

    // Try One Call 3.0 first (requires separate subscription), then fall back to 2.5 (free tier)
    let loaded = false;

    // Attempt One Call 3.0
    try {
      const url30 = `https://api.openweathermap.org/data/3.0/onecall?lat=${config.latitude}&lon=${config.longitude}&exclude=minutely&units=imperial&appid=${config.owm_api_key}`;
      const resp30 = await fetch(url30);
      if (resp30.ok) {
        const data = await resp30.json();
        weatherData = parseOneCallForecast(data);
        loaded = true;
      }
    } catch (_) { /* fall through to 2.5 */ }

    // Fallback: 2.5 free tier (3-hour intervals, 16 entries = 48 hours)
    if (!loaded) {
      const url25 = `https://api.openweathermap.org/data/2.5/forecast?lat=${config.latitude}&lon=${config.longitude}&units=imperial&appid=${config.owm_api_key}&cnt=16`;
      const resp25 = await fetch(url25);
      if (!resp25.ok) {
        const errBody = await resp25.json().catch(() => ({}));
        const errMsg = errBody.message || `HTTP ${resp25.status}`;
        throw new Error(`Weather API: ${errMsg}`);
      }
      const data25 = await resp25.json();
      weatherData = parse25Forecast(data25);
    }

    renderWeatherForecast();
  } catch (err) {
    console.error('Weather forecast failed:', err);
    const summary = document.getElementById('rainSummary');
    if (summary) {
      const msg = err.message || 'Unknown error';
      if (msg.includes('Invalid API key')) {
        summary.innerHTML = '<p class="text-muted" style="font-size: 0.85rem;">⚠️ OpenWeatherMap API key is invalid or not yet activated. New keys can take up to 2 hours. <a href="https://home.openweathermap.org/api_keys" target="_blank" style="color:var(--accent);">Check key status</a></p>';
      } else {
        summary.innerHTML = `<p class="text-muted" style="font-size: 0.85rem;">Failed to load weather forecast: ${msg}</p>`;
      }
    }
  }
}

function parseOneCallForecast(data) {
  // One Call API: hourly array with 48 entries
  const hours = (data.hourly || []).slice(0, 48).map(h => ({
    time: new Date(h.dt * 1000),
    temp: Math.round(h.temp),
    pop: Math.round((h.pop || 0) * 100), // probability of precipitation (0-100)
    rain: h.rain?.['1h'] || 0, // mm in last hour
    snow: h.snow?.['1h'] || 0,
    description: h.weather?.[0]?.description || '',
    icon: h.weather?.[0]?.icon || '',
    main: h.weather?.[0]?.main || '',
  }));
  // Daily forecast (up to 8 days) for extended rain outlook
  const daily = (data.daily || []).map(d => ({
    time: new Date(d.dt * 1000),
    pop: Math.round((d.pop || 0) * 100),
    rain: d.rain || 0,
    tempMax: Math.round(d.temp?.max ?? 0),
    tempMin: Math.round(d.temp?.min ?? 0),
    description: d.weather?.[0]?.description || '',
    main: d.weather?.[0]?.main || '',
  }));
  // NWS-style alerts from OWM
  const alerts = (data.alerts || []).map(a => ({
    event: a.event,
    sender: a.sender_name,
    start: new Date(a.start * 1000),
    end: new Date(a.end * 1000),
    description: a.description,
  }));
  return { hours, daily, alerts, current: data.current };
}

function parse25Forecast(data) {
  // 2.5 API: 3-hour intervals, up to 16 entries = 48 hours
  const hours = (data.list || []).map(item => ({
    time: new Date(item.dt * 1000),
    temp: Math.round(item.main.temp),
    pop: Math.round((item.pop || 0) * 100),
    rain: item.rain?.['3h'] || 0,
    snow: item.snow?.['3h'] || 0,
    description: item.weather?.[0]?.description || '',
    icon: item.weather?.[0]?.icon || '',
    main: item.weather?.[0]?.main || '',
  }));
  return { hours, daily: [], alerts: [], current: null };
}

function renderWeatherForecast() {
  if (!weatherData?.hours?.length) return;

  renderRainSummary();
  renderHourlyChart();
}

function renderRainSummary() {
  const container = document.getElementById('rainSummary');
  if (!container) return;

  const { hours, daily, alerts } = weatherData;
  const now = new Date();
  let html = '';

  // ---- Rain windows (contiguous hours where pop >= 30%) ----
  const windows = [];
  let currentWindow = null;

  for (const h of hours) {
    const hasRain = h.pop >= 30;
    if (hasRain) {
      if (!currentWindow) {
        currentWindow = { start: h.time, end: h.time, maxPop: h.pop, totalRain: h.rain };
      } else {
        currentWindow.end = h.time;
        currentWindow.maxPop = Math.max(currentWindow.maxPop, h.pop);
        currentWindow.totalRain += h.rain;
      }
    } else {
      if (currentWindow) {
        windows.push(currentWindow);
        currentWindow = null;
      }
    }
  }
  if (currentWindow) windows.push(currentWindow);

  if (!windows.length) {
    // No rain in 48h — find next rain from daily forecast
    let nextRainNote = '';
    if (daily?.length) {
      const nextRainDay = daily.find(d => d.pop >= 30 && d.time > now);
      if (nextRainDay) {
        const diffMs = nextRainDay.time - now;
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        const isUrgent = diffDays <= 2;
        const dateStr = nextRainDay.time.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        nextRainNote = `
          <div class="weather-alert__row ${isUrgent ? 'weather-alert--orange' : 'weather-alert--muted'}">
            <span class="weather-alert__icon">&#127783;&#65039;</span>
            <span>Next rain: ~${diffDays} day${diffDays !== 1 ? 's' : ''} (${nextRainDay.pop}% chance ${dateStr})</span>
          </div>`;
      } else {
        nextRainNote = `
          <div class="weather-alert__row weather-alert--muted">
            <span class="weather-alert__icon">&#127783;&#65039;</span>
            <span>Next rain: none in 8-day forecast</span>
          </div>`;
      }
    }
    html += `
      <div class="rain-summary__status rain-summary--clear">
        <span class="rain-summary__icon">&#9728;&#65039;</span>
        <span>No rain expected in the next 48 hours</span>
      </div>
      ${nextRainNote}`;
  } else {
    const windowsHtml = windows.map(w => {
      const startStr = formatWeatherTime(w.start, now);
      const endStr = formatWeatherTime(w.end, now);
      const timeRange = startStr === endStr ? startStr : `${startStr} - ${endStr}`;
      return `
        <div class="rain-window">
          <span class="rain-window__icon">&#127783;&#65039;</span>
          <span class="rain-window__time">${timeRange}</span>
          <span class="rain-window__chance">${w.maxPop}% chance</span>
        </div>`;
    }).join('');

    html += `
      <div class="rain-summary__status rain-summary--rain">
        <span class="rain-summary__icon">&#127783;&#65039;</span>
        <span>Rain expected</span>
      </div>
      <div class="rain-windows">${windowsHtml}</div>`;
  }

  // ---- Alerts section (separated visually) ----
  html += '<div class="weather-alerts">';

  // Temperature warnings
  const maxTemp = Math.max(...hours.map(h => h.temp));
  const minTemp = Math.min(...hours.map(h => h.temp));

  if (maxTemp >= 100) {
    const firstHot = hours.find(h => h.temp >= 100);
    const timeStr = formatWeatherTime(firstHot.time, now);
    html += `
      <div class="weather-alert__row weather-alert--red">
        <span class="weather-alert__icon">&#x1F525;</span>
        <span>Heat warning: ${maxTemp}&deg;F expected (${timeStr})</span>
      </div>`;
  } else {
    html += `
      <div class="weather-alert__row weather-alert--green">
        <span class="weather-alert__icon">&#x2705;</span>
        <span>No heat warnings</span>
      </div>`;
  }

  if (minTemp <= 32) {
    const firstCold = hours.find(h => h.temp <= 32);
    const timeStr = formatWeatherTime(firstCold.time, now);
    html += `
      <div class="weather-alert__row weather-alert--blue">
        <span class="weather-alert__icon">&#x1F976;</span>
        <span>Cold warning: ${minTemp}&deg;F expected (${timeStr})</span>
      </div>`;
  } else {
    html += `
      <div class="weather-alert__row weather-alert--green">
        <span class="weather-alert__icon">&#x2705;</span>
        <span>No cold warnings</span>
      </div>`;
  }

  // Severe weather alerts
  if (alerts?.length) {
    for (const a of alerts) {
      const startStr = formatWeatherTime(a.start, now);
      const endStr = formatWeatherTime(a.end, now);
      html += `
        <div class="weather-alert__row weather-alert--red">
          <span class="weather-alert__icon">&#x26A0;&#xFE0F;</span>
          <span>${escapeHtml(a.event)}: ${startStr} - ${endStr}</span>
        </div>`;
    }
  } else {
    html += `
      <div class="weather-alert__row weather-alert--green">
        <span class="weather-alert__icon">&#x2705;</span>
        <span>No severe weather alerts</span>
      </div>`;
  }

  html += '</div>';

  container.innerHTML = html;
}

function renderHourlyChart() {
  const container = document.getElementById('weatherChart');
  if (!container) return;

  const { hours } = weatherData;
  const now = new Date();

  // Group by day
  const days = {};
  for (const h of hours) {
    const dayKey = h.time.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    if (!days[dayKey]) days[dayKey] = [];
    days[dayKey].push(h);
  }

  let html = '';
  for (const [dayLabel, dayHours] of Object.entries(days)) {
    html += `<div class="weather-day">
      <div class="weather-day__label">${dayLabel}</div>
      <div class="weather-day__hours">`;

    for (const h of dayHours) {
      const timeStr = h.time.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
      const barHeight = Math.max(2, h.pop);
      const barColor = h.pop >= 70 ? '#3b82f6' : h.pop >= 30 ? '#93c5fd' : '#e5e7eb';
      const rainClass = h.pop >= 30 ? 'has-rain' : '';

      html += `
        <div class="weather-hour ${rainClass}" title="${h.temp}°F, ${h.pop}% rain, ${h.description}">
          <div class="weather-hour__pop-bar" style="height: ${barHeight}%; background: ${barColor};"></div>
          <div class="weather-hour__pop-label">${h.pop > 0 ? h.pop + '%' : ''}</div>
          <div class="weather-hour__temp">${h.temp}°</div>
          <div class="weather-hour__time">${timeStr}</div>
        </div>`;
    }

    html += `</div></div>`;
  }

  container.innerHTML = html;
}

function formatWeatherTime(date, now) {
  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });

  if (isToday) return `Today ${timeStr}`;
  if (isTomorrow) return `Tomorrow ${timeStr}`;
  return date.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + timeStr;
}

// =============================================
// ADMIN: DEVICE DISCOVERY
// =============================================
async function discoverDevices() {
  const btn = document.getElementById('discoverDevicesBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Discovering...';
  }

  try {
    const result = await nestApi('listDevices');
    const devices = result.devices || [];
    const thermostatsFound = devices.filter(d =>
      d.type === 'sdm.devices.types.THERMOSTAT'
    );

    if (!thermostatsFound.length) {
      showToast('No Nest thermostats found', 'warning');
      return;
    }

    // Upsert devices into nest_devices table
    for (let i = 0; i < thermostatsFound.length; i++) {
      const device = thermostatsFound[i];
      const deviceId = device.name; // Full SDM path
      const roomName = device.traits?.['sdm.devices.traits.Info']?.customName
        || device.parentRelations?.[0]?.displayName
        || `Thermostat ${i + 1}`;

      // Check if device already exists
      const { data: existing } = await supabase
        .from('nest_devices')
        .select('id')
        .eq('sdm_device_id', deviceId)
        .single();

      if (existing) {
        await supabase.from('nest_devices')
          .update({ room_name: roomName, updated_at: new Date().toISOString() })
          .eq('sdm_device_id', deviceId);
      } else {
        await supabase.from('nest_devices').insert({
          sdm_device_id: deviceId,
          room_name: roomName,
          device_type: 'thermostat',
          display_order: i + 1,
        });
      }
    }

    showToast(`Found ${thermostatsFound.length} thermostat(s)`, 'success');
    await loadThermostats();
    renderThermostats();
    await refreshAllStates();
  } catch (err) {
    showToast(`Discovery failed: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Discover Devices';
    }
  }
}
