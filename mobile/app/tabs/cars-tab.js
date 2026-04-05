/**
 * Cars Tab - Mobile Tesla vehicle cards
 * Shows vehicle cards with battery, status, lock state.
 * Controls: lock/unlock, flash lights.
 */

import { loadVehicles, sendCommand, formatSyncTime, getDataRows } from '../../../shared/services/cars-data.js';
import { PollManager } from '../../../shared/services/poll-manager.js';

let vehicles = [];
let poller = null;

// =============================================
// TOAST
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
// SVG ICONS
// =============================================
const ICONS = {
  battery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="6" width="18" height="12" rx="2"/><line x1="23" y1="10" x2="23" y2="14"/></svg>',
  status: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>',
};

const CAR_SVG = {
  model3: '<svg viewBox="0 0 400 160" fill="none"><path d="M50 110 C50 110 55 65 90 55 L160 45 C170 43 200 38 240 38 L310 42 C340 48 360 65 365 80 L370 95 C372 100 370 110 365 110" stroke="currentColor" stroke-width="3"/><circle cx="105" cy="112" r="22" stroke="currentColor" stroke-width="3"/><circle cx="315" cy="112" r="22" stroke="currentColor" stroke-width="3"/></svg>',
  modelY: '<svg viewBox="0 0 400 160" fill="none"><path d="M45 115 C45 112 48 70 85 52 L150 40 C165 37 200 33 245 33 L315 38 C345 45 362 65 368 82 L373 98 C375 105 372 115 368 115" stroke="currentColor" stroke-width="3"/><circle cx="105" cy="117" r="23" stroke="currentColor" stroke-width="3"/><circle cx="318" cy="117" r="23" stroke="currentColor" stroke-width="3"/></svg>',
};

// =============================================
// RENDERING
// =============================================
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function render() {
  const container = document.getElementById('carsContent');
  if (!container) return;

  if (!vehicles.length) {
    container.innerHTML = '<div class="m-loading-inline">No vehicles available.</div>';
    return;
  }

  container.innerHTML = vehicles.map(car => renderCard(car)).join('');
  bindEvents();
}

function renderCard(car) {
  const svgKey = car.svg_key || 'modelY';
  const carSvg = CAR_SVG[svgKey] || CAR_SVG.modelY;
  const dataRows = getDataRows(car);
  const syncTime = formatSyncTime(car.last_synced_at);
  const isLocked = car.last_state?.locked;
  const nextCmd = isLocked === false ? 'door_lock' : 'door_unlock';
  const nextLabel = isLocked === false ? 'Lock' : 'Unlock';

  const dataHtml = dataRows.map(row => `
    <div class="m-car-data-row">
      <span class="m-car-data-row__icon">${ICONS[row.icon] || ''}</span>
      <span class="m-car-data-row__label">${row.label}</span>
      <span class="m-car-data-row__value" ${row.color ? `style="color:${row.color}"` : ''}>${row.value}</span>
    </div>
  `).join('');

  const imageContent = car.image_url
    ? `<img src="${esc(car.image_url)}" alt="${esc(car.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
       <div style="display:none;width:70%;color:var(--m-text-dim)">${carSvg}</div>`
    : `<div style="width:70%;color:var(--m-text-dim)">${carSvg}</div>`;

  return `
    <div class="m-car-card" data-vid="${car.id}">
      <div class="m-car-card__image">${imageContent}</div>
      <div class="m-car-card__body">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div class="m-car-card__name">${esc(car.name)}</div>
            <div class="m-car-card__model">${esc((car.vehicle_make ? car.vehicle_make + ' ' : '') + car.vehicle_model + ' ' + car.year)}</div>
          </div>
          ${car.color_hex ? `<span style="width:14px;height:14px;border-radius:50%;background:${car.color_hex};border:1px solid var(--m-border)"></span>` : ''}
        </div>

        <div class="m-car-data-grid">${dataHtml}</div>

        <div class="m-car-controls">
          <button class="m-car-cmd-btn" data-vid="${car.id}" data-cmd="${nextCmd}">
            ${nextLabel}
          </button>
          <button class="m-car-cmd-btn" data-vid="${car.id}" data-cmd="flash_lights">
            Flash
          </button>
        </div>

        <div class="m-car-sync-time">${syncTime}</div>
      </div>
    </div>
  `;
}

// =============================================
// EVENTS
// =============================================
function bindEvents() {
  const container = document.getElementById('carsContent');
  if (!container) return;

  container.onclick = async (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn || btn.disabled) return;

    const vehicleId = parseInt(btn.dataset.vid);
    const command = btn.dataset.cmd;

    btn.disabled = true;
    btn.classList.add('m-car-cmd-btn--loading');

    try {
      const result = await sendCommand(vehicleId, command);
      const friendlyCmd = command.replace(/_/g, ' ').replace('door ', '');
      toast(`${result?.vehicle_name || 'Vehicle'}: ${friendlyCmd} sent`, 'success');
      // Refresh after command
      setTimeout(refreshFromDB, 2000);
    } catch (err) {
      toast(`Command failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('m-car-cmd-btn--loading');
    }
  };
}

// =============================================
// POLLING
// =============================================
async function refreshFromDB() {
  try {
    vehicles = await loadVehicles();
    render();
  } catch (err) {
    console.warn('Cars refresh failed:', err.message);
  }
}

// =============================================
// INIT
// =============================================
export async function init(user) {
  try {
    vehicles = await loadVehicles();
    render();

    poller = new PollManager(() => refreshFromDB(), 30000);
    poller.start();
  } catch (err) {
    console.error('Cars tab init failed:', err);
    const container = document.getElementById('carsContent');
    if (container) {
      container.innerHTML = '<div class="m-error">Failed to load vehicles.</div>';
    }
  }
}
