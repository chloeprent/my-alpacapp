/**
 * Climate Tab - Mobile thermostat cards
 * Shows Nest thermostats filtered per resident (via shared service).
 * Controls: current temp display, target temp +/-, mode select, eco toggle.
 */

import { loadThermostats, refreshAllStates, setTemperature, setMode, toggleEco, formatMode } from '../../../shared/services/climate-data.js';
import { PollManager } from '../../../shared/services/poll-manager.js';

let thermostats = [];
let stateMap = {};
let poller = null;
let appUser = null;

// =============================================
// TOAST (lightweight mobile toast)
// =============================================
function toast(msg, type = 'info', ms = 2500) {
  let container = document.getElementById('mToastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'mToastContainer';
    container.className = 'm-toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `m-toast m-toast--${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('m-toast-exit'); setTimeout(() => el.remove(), 300); }, ms);
}

// =============================================
// RENDERING
// =============================================
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function render() {
  const container = document.getElementById('climateContent');
  if (!container) return;

  if (!thermostats.length) {
    container.innerHTML = '<div class="m-loading-inline">No thermostats available for your room.</div>';
    return;
  }

  container.innerHTML = thermostats.map(t => renderCard(t)).join('');
  bindEvents();
}

function renderCard(t) {
  const s = t.state || stateMap[t.sdmDeviceId] || {};
  const isHeating = s.hvacStatus === 'HEATING';
  const isCooling = s.hvacStatus === 'COOLING';
  const isEco = s.ecoMode === 'MANUAL_ECO';
  const isOnline = s.connectivity === 'ONLINE';

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
  let badgeClass = 'm-thermo-badge--idle';
  let badgeText = 'Idle';
  if (isHeating) { badgeClass = 'm-thermo-badge--heating'; badgeText = 'Heating'; }
  else if (isCooling) { badgeClass = 'm-thermo-badge--cooling'; badgeText = 'Cooling'; }

  // Card accent
  const cardClass = isHeating ? 'heating' : isCooling ? 'cooling' : '';

  return `
    <div class="m-thermo-card ${cardClass}" data-device="${esc(t.sdmDeviceId)}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span class="m-thermo-card__name">${esc(t.roomName)}</span>
        ${s.connectivity ? `<span class="m-dot ${isOnline ? 'm-dot--green' : 'm-dot--red'}"></span>` : ''}
      </div>

      <div class="m-thermo-card__current">
        ${s.currentTempF != null ? s.currentTempF : '--'}<span class="m-thermo-card__unit">&deg;F</span>
      </div>
      ${s.humidity != null ? `<div class="m-thermo-card__humidity">${s.humidity}% humidity</div>` : ''}

      <div class="m-thermo-badges">
        <span class="m-thermo-badge ${badgeClass}">${badgeText}</span>
        ${isEco ? '<span class="m-thermo-badge m-thermo-badge--eco">Eco</span>' : ''}
        ${s.mode ? `<span class="m-thermo-badge m-thermo-badge--idle">${esc(formatMode(s.mode))}</span>` : ''}
      </div>

      <div class="m-thermo-target">
        <button data-action="tempDown" data-device="${esc(t.sdmDeviceId)}" ${s.mode === 'OFF' ? 'disabled' : ''}>&minus;</button>
        <div>
          <div class="m-thermo-target__label">Target</div>
          <div class="m-thermo-target__value">${targetDisplay === 'Off' ? targetDisplay : `${targetDisplay}&deg;F`}</div>
        </div>
        <button data-action="tempUp" data-device="${esc(t.sdmDeviceId)}" ${s.mode === 'OFF' ? 'disabled' : ''}>+</button>
      </div>

      <div class="m-thermo-mode">
        <select data-action="setMode" data-device="${esc(t.sdmDeviceId)}">
          <option value="HEAT" ${s.mode === 'HEAT' ? 'selected' : ''}>Heat</option>
          <option value="COOL" ${s.mode === 'COOL' ? 'selected' : ''}>Cool</option>
          <option value="HEATCOOL" ${s.mode === 'HEATCOOL' ? 'selected' : ''}>Heat/Cool</option>
          <option value="OFF" ${s.mode === 'OFF' ? 'selected' : ''}>Off</option>
        </select>
        <button class="m-eco-btn ${isEco ? 'active' : ''}"
                data-action="toggleEco" data-device="${esc(t.sdmDeviceId)}">
          Eco
        </button>
      </div>
    </div>
  `;
}

function updateCard(sdmDeviceId) {
  const t = thermostats.find(th => th.sdmDeviceId === sdmDeviceId);
  if (!t) return;
  const card = document.querySelector(`[data-device="${CSS.escape(sdmDeviceId)}"]`);
  if (!card) return;
  card.outerHTML = renderCard(t);
  bindEvents();
}

// =============================================
// EVENTS
// =============================================
function bindEvents() {
  const container = document.getElementById('climateContent');
  if (!container) return;

  // Remove old listeners by replacing with cloned nodes would be heavy — use delegation instead
  container.onclick = async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const deviceId = btn.dataset.device;

    if (action === 'tempUp' || action === 'tempDown') {
      await handleSetTemp(deviceId, action === 'tempUp' ? 'up' : 'down');
    } else if (action === 'toggleEco') {
      await handleToggleEco(deviceId);
    }
  };

  container.onchange = async (e) => {
    const sel = e.target.closest('[data-action="setMode"]');
    if (!sel) return;
    await handleSetMode(sel.dataset.device, sel.value);
  };
}

async function handleSetTemp(sdmDeviceId, direction) {
  const t = thermostats.find(th => th.sdmDeviceId === sdmDeviceId);
  if (!t?.state || t.state.mode === 'OFF') return;

  try {
    await setTemperature(sdmDeviceId, t.state, direction);
    toast('Temperature adjusted', 'success', 2000);
    // Optimistic update
    const s = t.state;
    const delta = direction === 'up' ? 1 : -1;
    if (s.heatSetpointF != null) s.heatSetpointF += delta;
    if (s.coolSetpointF != null) s.coolSetpointF += delta;
    updateCard(sdmDeviceId);
    // Confirm from API after delay
    setTimeout(() => refreshStates(), 2000);
  } catch (err) {
    toast(`Failed: ${err.message}`, 'error');
  }
}

async function handleSetMode(sdmDeviceId, mode) {
  try {
    await setMode(sdmDeviceId, mode);
    toast(`Mode set to ${formatMode(mode)}`, 'success', 2000);
    setTimeout(() => refreshStates(), 2000);
  } catch (err) {
    toast(`Failed: ${err.message}`, 'error');
  }
}

async function handleToggleEco(sdmDeviceId) {
  const t = thermostats.find(th => th.sdmDeviceId === sdmDeviceId);
  const currentEco = t?.state?.ecoMode;

  try {
    await toggleEco(sdmDeviceId, currentEco);
    const newEco = currentEco === 'MANUAL_ECO' ? 'OFF' : 'MANUAL_ECO';
    toast(`Eco ${newEco === 'MANUAL_ECO' ? 'enabled' : 'disabled'}`, 'success', 2000);
    // Optimistic update
    if (t?.state) t.state.ecoMode = newEco;
    updateCard(sdmDeviceId);
    setTimeout(() => refreshStates(), 2000);
  } catch (err) {
    toast(`Failed: ${err.message}`, 'error');
  }
}

// =============================================
// POLLING
// =============================================
async function refreshStates() {
  try {
    stateMap = await refreshAllStates(thermostats);
    // Merge into local thermostat objects
    for (const t of thermostats) {
      if (stateMap[t.sdmDeviceId]) {
        t.state = stateMap[t.sdmDeviceId];
      }
    }
    render();
  } catch (err) {
    console.warn('Climate refresh failed:', err.message);
  }
}

// =============================================
// INIT (called by mobile-app.js)
// =============================================
export async function init(user) {
  appUser = user;

  try {
    thermostats = await loadThermostats(user);
    render();

    // Start polling for live state
    poller = new PollManager(() => refreshStates(), 30000);
    poller.start();
  } catch (err) {
    console.error('Climate tab init failed:', err);
    const container = document.getElementById('climateContent');
    if (container) {
      container.innerHTML = `<div class="m-error">Failed to load climate data.</div>`;
    }
  }
}
