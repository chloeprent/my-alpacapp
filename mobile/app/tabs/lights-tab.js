/**
 * Lights Tab - Mobile Govee lighting controls
 * Shows group cards organized by area with on/off toggle, brightness slider, color presets.
 */

import {
  loadGroupsFromDB, toggleGroup, setBrightness, setColor, setColorTemp,
  getDeviceState, allOff, COLOR_PRESETS,
} from '../../../shared/services/lighting-data.js';
import { PollManager } from '../../../shared/services/poll-manager.js';

let sections = [];
let groups = [];
let groupStates = {}; // { groupId: { on, brightness, color, disconnected } }
let poller = null;

const brightnessTimers = {};

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
// RENDERING
// =============================================
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function render() {
  const container = document.getElementById('lightsContent');
  if (!container) return;

  if (!groups.length) {
    container.innerHTML = '<div class="m-loading-inline">No lighting groups found.</div>';
    return;
  }

  // "All Off" button + sections
  let html = `
    <div class="m-section-header">
      <span class="m-section-title">Lights</span>
      <button class="m-btn m-btn--small m-btn--secondary" id="allOffBtn">All Off</button>
    </div>
  `;

  for (const section of sections) {
    html += `<div style="margin-bottom:6px">
      <div style="font-size:12px;font-weight:600;color:var(--m-text-muted);text-transform:uppercase;letter-spacing:0.05em;padding:8px 0 4px">${esc(section.name)}</div>
    `;
    for (const group of section.groups) {
      html += renderCard(group);
    }
    html += '</div>';
  }

  container.innerHTML = html;
  bindEvents();
}

function renderCard(group) {
  const s = groupStates[group.groupId] || {};
  const isOn = s.on === true;
  const brightness = s.brightness ?? 50;
  const offClass = isOn ? '' : 'off';

  return `
    <div class="m-light-card ${offClass}" data-group="${esc(group.groupId)}">
      <div class="m-light-card__header">
        <div>
          <div class="m-light-card__name">${esc(group.name)}</div>
          <div class="m-light-card__info">${group.deviceCount ? group.deviceCount + ' devices' : ''} ${group.models ? '· ' + esc(group.models) : ''}</div>
        </div>
        <label class="m-toggle">
          <input type="checkbox" data-action="toggle" data-group="${esc(group.groupId)}" ${isOn ? 'checked' : ''}>
          <span class="m-toggle__track"></span>
          <span class="m-toggle__thumb"></span>
        </label>
      </div>

      <div class="m-brightness-row">
        <input type="range" min="1" max="100" value="${brightness}" class="m-slider"
               data-action="brightness" data-group="${esc(group.groupId)}">
        <span class="m-brightness-row__label">${brightness}%</span>
      </div>

      <div class="m-color-presets">
        ${COLOR_PRESETS.map(p => `
          <div class="m-color-preset" style="background:${p.hex}"
               data-action="color" data-group="${esc(group.groupId)}"
               data-hex="${p.hex}" ${p.temp ? `data-temp="${p.temp}"` : ''}
               title="${esc(p.name)}"></div>
        `).join('')}
      </div>
    </div>
  `;
}

// =============================================
// EVENTS
// =============================================
function bindEvents() {
  const container = document.getElementById('lightsContent');
  if (!container) return;

  // All Off button
  document.getElementById('allOffBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('allOffBtn');
    btn.disabled = true;
    btn.textContent = 'Turning off...';
    try {
      const result = await allOff(groups);
      toast(`Turned off ${result.successes} group(s)`, 'success');
      // Mark all as off
      for (const g of groups) {
        if (groupStates[g.groupId]) groupStates[g.groupId].on = false;
      }
      render();
    } catch (err) {
      toast('All off failed', 'error');
    }
    btn.disabled = false;
    btn.textContent = 'All Off';
  });

  // Toggle switches
  container.querySelectorAll('[data-action="toggle"]').forEach(input => {
    input.addEventListener('change', async (e) => {
      const groupId = e.target.dataset.group;
      const on = e.target.checked;
      try {
        await toggleGroup(groupId, on);
        if (!groupStates[groupId]) groupStates[groupId] = {};
        groupStates[groupId].on = on;
        // Update card appearance
        const card = e.target.closest('.m-light-card');
        card?.classList.toggle('off', !on);
      } catch (err) {
        toast(`Toggle failed: ${err.message}`, 'error');
        e.target.checked = !on; // revert
      }
    });
  });

  // Brightness sliders (debounced)
  container.querySelectorAll('[data-action="brightness"]').forEach(input => {
    input.addEventListener('input', (e) => {
      const groupId = e.target.dataset.group;
      const value = parseInt(e.target.value);
      // Update label immediately
      const label = e.target.closest('.m-brightness-row')?.querySelector('.m-brightness-row__label');
      if (label) label.textContent = `${value}%`;

      // Debounce the API call
      clearTimeout(brightnessTimers[groupId]);
      brightnessTimers[groupId] = setTimeout(async () => {
        try {
          await setBrightness(groupId, value);
          if (!groupStates[groupId]) groupStates[groupId] = {};
          groupStates[groupId].brightness = value;
        } catch (err) {
          toast(`Brightness failed: ${err.message}`, 'error');
        }
      }, 300);
    });
  });

  // Color presets
  container.querySelectorAll('[data-action="color"]').forEach(el => {
    el.addEventListener('click', async () => {
      const groupId = el.dataset.group;
      const hex = el.dataset.hex;
      const temp = el.dataset.temp;

      try {
        if (temp) {
          await setColorTemp(groupId, parseInt(temp));
        } else {
          await setColor(groupId, hex);
        }
        if (!groupStates[groupId]) groupStates[groupId] = {};
        groupStates[groupId].color = hex;
        toast('Color updated', 'success', 1500);
      } catch (err) {
        toast(`Color failed: ${err.message}`, 'error');
      }
    });
  });
}

// =============================================
// STATE LOADING
// =============================================
async function refreshAllStates() {
  // Fetch state for each group (staggered to respect rate limits)
  for (const group of groups) {
    try {
      const state = await getDeviceState(group.groupId);
      if (state) {
        groupStates[group.groupId] = state;
      }
    } catch {
      // Silently skip individual failures
    }
    // Small delay between API calls to respect rate limits
    await new Promise(r => setTimeout(r, 250));
  }
  render();
}

// =============================================
// INIT
// =============================================
export async function init(user) {
  try {
    const data = await loadGroupsFromDB();
    groups = data.groups;
    sections = data.sections;
    render();

    // Load states in background (doesn't block render)
    refreshAllStates();

    // Poll every 30s
    poller = new PollManager(() => refreshAllStates(), 30000);
    // Start after initial state load finishes (give 10s for first load)
    setTimeout(() => poller.start(), 15000);
  } catch (err) {
    console.error('Lights tab init failed:', err);
    const container = document.getElementById('lightsContent');
    if (container) {
      container.innerHTML = '<div class="m-error">Failed to load lighting groups.</div>';
    }
  }
}
