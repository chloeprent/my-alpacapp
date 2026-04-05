/**
 * Appliances Page - LG washer/dryer monitoring + Anova Precision Oven control + Glowforge status + 3D Printer.
 * Laundry: live status from lg_appliances table (poller on DO droplet writes state; this page reads every 15s).
 * Cooking: live Anova Precision Oven status + controls via anova-control edge function.
 * Maker Tools: Glowforge laser cutter status via glowforge-control edge function.
 * 3D Printing: FlashForge printer status + controls via printer-control edge function.
 */

import { supabase } from '../shared/supabase.js';
import { initResidentPage, showToast } from '../shared/resident-shell.js';
import { hasPermission } from '../shared/auth.js';
import { getResidentDeviceScope } from '../shared/services/resident-device-scope.js';
import { PollManager } from '../shared/services/poll-manager.js';
import { supabaseHealth } from '../shared/supabase-health.js';
import {
  loadOvens, refreshOvenState, startCook, stopCook,
  getOvenStateDisplay, getCurrentTemp, getTargetTemp, getProbeTemp,
  getTimerDisplay, getDoorStatus, getFanSpeed, getSteamInfo,
  getHeatingElements, isWaterTankEmpty, formatSyncTime as formatOvenSyncTime,
  buildSimpleCookStages,
} from '../shared/services/oven-data.js';
import {
  loadGlowforgeMachines, refreshGlowforgeStatus,
  getMachineStateDisplay, getLastActivity, getMachineModel,
  formatSyncTime as formatGlowforgeSyncTime,
} from '../shared/services/glowforge-data.js';
import {
  loadPrinters, refreshPrinterStatus,
  getPrinterStateDisplay, getNozzleTemp, getBedTemp, getPrintProgress,
  isLedOn, toggleLight, pausePrint, resumePrint, cancelPrint,
  formatSyncTime as formatPrinterSyncTime,
} from '../shared/services/printer-data.js';

// =============================================
// CONFIGURATION
// =============================================
const POLL_INTERVAL_MS = 15000;

// =============================================
// STATE
// =============================================
let appliances = [];
let anovaOvens = [];
let glowforgeMachines = [];
let watchedAppliances = new Set();
let poll = null;
let countdownTimer = null;
let currentUserRole = null;
let currentAppUserId = null;
let deviceScope = null;
let loadFailed = false;
let canControlOven = false;
let refreshingOven = new Set();
let refreshingGlowforge = false;
let printerDevices = [];
let refreshingPrinter = new Set();
let canControlPrinter = false;

// =============================================
// SVG ICONS
// =============================================
const WASHER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2" y="2" width="20" height="20" rx="2"/>
  <circle cx="12" cy="14" r="5"/>
  <circle cx="12" cy="14" r="2.5" stroke-dasharray="3 2"/>
  <circle cx="6" cy="5.5" r="1" fill="currentColor" stroke="none"/>
  <circle cx="9" cy="5.5" r="1" fill="currentColor" stroke="none"/>
  <line x1="14" y1="5.5" x2="20" y2="5.5"/>
</svg>`;

const DRYER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2" y="2" width="20" height="20" rx="2"/>
  <circle cx="12" cy="14" r="5"/>
  <path d="M10 12 C10 13 11 14.5 12 14.5 S14 13 14 12 S13 10.5 12 10.5 S10 12 10 12" stroke-width="1.2"/>
  <circle cx="6" cy="5.5" r="1" fill="currentColor" stroke="none"/>
  <circle cx="9" cy="5.5" r="1" fill="currentColor" stroke="none"/>
  <line x1="14" y1="5.5" x2="20" y2="5.5"/>
</svg>`;

const BELL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;

const OVEN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2" y="3" width="20" height="18" rx="2"/>
  <rect x="5" y="10" width="14" height="8" rx="1"/>
  <line x1="5" y1="7.5" x2="19" y2="7.5"/>
  <circle cx="7" cy="5.5" r="0.75" fill="currentColor" stroke="none"/>
  <circle cx="10" cy="5.5" r="0.75" fill="currentColor" stroke="none"/>
  <circle cx="13" cy="5.5" r="0.75" fill="currentColor" stroke="none"/>
</svg>`;

const REFRESH_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;

const GLOWFORGE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2" y="4" width="20" height="16" rx="2"/>
  <line x1="2" y1="8" x2="22" y2="8"/>
  <circle cx="5" cy="6" r="0.75" fill="currentColor" stroke="none"/>
  <circle cx="8" cy="6" r="0.75" fill="currentColor" stroke="none"/>
  <path d="M8 14 L16 14" stroke-dasharray="2 1.5" stroke-width="1.2"/>
  <path d="M12 11 L12 17" stroke-dasharray="2 1.5" stroke-width="1.2"/>
  <circle cx="12" cy="14" r="1" fill="currentColor" stroke="none" opacity="0.6"/>
</svg>`;

const PRINTER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="3" width="18" height="18" rx="2"/>
  <rect x="6" y="14" width="12" height="4" rx="0.5" stroke-dasharray="2 1.5"/>
  <line x1="6" y1="8" x2="18" y2="8"/>
  <circle cx="7" cy="5.5" r="0.75" fill="currentColor" stroke="none"/>
  <circle cx="10" cy="5.5" r="0.75" fill="currentColor" stroke="none"/>
  <path d="M14 10 L14 13 M12 11.5 L16 11.5" stroke-width="1.2"/>
</svg>`;

// =============================================
// SECTION COLLAPSE PERSISTENCE
// =============================================
const SECTION_COLLAPSE_KEY = 'appliances_collapsed_sections';

function getSectionOpenState(sectionId) {
  try {
    const collapsed = JSON.parse(localStorage.getItem(SECTION_COLLAPSE_KEY) || '[]');
    return !collapsed.includes(sectionId);
  } catch { return true; }
}

function saveSectionState(sectionId, isOpen) {
  try {
    let collapsed = JSON.parse(localStorage.getItem(SECTION_COLLAPSE_KEY) || '[]');
    if (isOpen) {
      collapsed = collapsed.filter(id => id !== sectionId);
    } else if (!collapsed.includes(sectionId)) {
      collapsed.push(sectionId);
    }
    localStorage.setItem(SECTION_COLLAPSE_KEY, JSON.stringify(collapsed));
  } catch {}
}

// =============================================
// LAUNDRY HELPERS
// =============================================
const RUNNING_STATES = new Set([
  'RUNNING', 'RINSING', 'SPINNING', 'DRYING',
  'STEAM_SOFTENING', 'COOL_DOWN', 'DETECTING',
  'REFRESHING', 'RINSE_HOLD',
]);

function formatTimeRemaining(hours, minutes) {
  const h = hours || 0;
  const m = minutes || 0;
  if (h === 0 && m === 0) return '';
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatSyncTime(lastSyncedAt) {
  if (!lastSyncedAt) return 'Never synced';
  const diff = Date.now() - new Date(lastSyncedAt).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return new Date(lastSyncedAt).toLocaleDateString();
}

function getStateDisplay(appliance) {
  const s = appliance.last_state || {};
  const state = s.currentState || 'POWER_OFF';

  if (state === 'POWER_OFF' || state === 'SLEEP') return { text: 'Off', color: 'var(--text-muted)', isRunning: false, isDone: false };
  if (state === 'END') return { text: 'Done!', color: '#f59e0b', isRunning: false, isDone: true };
  if (state === 'PAUSE') return { text: 'Paused', color: '#f59e0b', isRunning: false, isDone: false };
  if (state === 'ERROR') return { text: 'Error', color: 'var(--occupied)', isRunning: false, isDone: false };
  if (state === 'RESERVED') return { text: 'Scheduled', color: '#8b5cf6', isRunning: false, isDone: false };
  if (state === 'INITIAL' || state === 'DETECTING') return { text: 'Starting...', color: 'var(--available)', isRunning: true, isDone: false };

  if (RUNNING_STATES.has(state)) {
    if (state === 'RINSING') return { text: 'Rinsing', color: 'var(--available)', isRunning: true, isDone: false };
    if (state === 'SPINNING') return { text: 'Spinning', color: 'var(--available)', isRunning: true, isDone: false };
    if (state === 'DRYING') return { text: 'Drying', color: 'var(--available)', isRunning: true, isDone: false };
    if (state === 'STEAM_SOFTENING') return { text: 'Steam Softening', color: 'var(--available)', isRunning: true, isDone: false };
    if (state === 'COOL_DOWN') return { text: 'Cooling Down', color: 'var(--available)', isRunning: true, isDone: false };
    const label = appliance.device_type === 'dryer' ? 'Drying' : 'Washing';
    return { text: `${label}...`, color: 'var(--available)', isRunning: true, isDone: false };
  }

  return { text: state, color: 'var(--text-muted)', isRunning: false, isDone: false };
}

function getProgressPercent(state) {
  if (!state) return 0;
  const totalMin = (state.totalHour || 0) * 60 + (state.totalMinute || 0);
  const remainMin = (state.remainHour || 0) * 60 + (state.remainMinute || 0);
  if (totalMin <= 0) return 0;
  const elapsed = totalMin - remainMin;
  return Math.max(0, Math.min(100, Math.round((elapsed / totalMin) * 100)));
}

// =============================================
// DATA LOADING
// =============================================
async function loadAppliances() {
  const { data, error } = await supabase
    .from('lg_appliances')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) {
    console.warn('Failed to load appliances:', error.message);
    loadFailed = true;
    supabaseHealth.recordFailure();
    throw error;
  }
  loadFailed = false;
  supabaseHealth.recordSuccess();
  appliances = (data || []).filter((appliance) => {
    if (!deviceScope || deviceScope.fullAccess) return true;
    return deviceScope.canAccessSpaceId(appliance.space_id)
      || deviceScope.canAccessSpaceName(appliance.space_name)
      || deviceScope.canAccessSpaceName(appliance.location)
      || deviceScope.canAccessSpaceName(appliance.name);
  });
}

async function loadAnovaOvens() {
  try {
    anovaOvens = await loadOvens();
  } catch (err) {
    console.warn('Failed to load anova ovens:', err.message);
  }
}

async function loadGlowforge() {
  try {
    glowforgeMachines = await loadGlowforgeMachines();
  } catch (err) {
    console.warn('Failed to load glowforge machines:', err.message);
  }
}

async function loadPrinterDevices() {
  try {
    printerDevices = await loadPrinters();
  } catch (err) {
    console.warn('Failed to load 3D printers:', err.message);
  }
}

async function loadWatcherStatus() {
  if (!currentAppUserId) return;
  const { data, error } = await supabase
    .from('laundry_watchers')
    .select('appliance_id')
    .eq('app_user_id', currentAppUserId);

  if (error) {
    console.warn('Failed to load watcher status:', error.message);
    return;
  }
  watchedAppliances = new Set((data || []).map(w => w.appliance_id));
}

// =============================================
// RENDERING — LAUNDRY
// =============================================
function renderLaundryCard(a) {
  const state = getStateDisplay(a);
  const s = a.last_state || {};
  const progress = getProgressPercent(s);
  const timeStr = formatTimeRemaining(s.remainHour, s.remainMinute);
  const watching = watchedAppliances.has(a.id);
  const icon = a.device_type === 'dryer' ? DRYER_ICON : WASHER_ICON;
  const stateClass = state.isRunning ? 'running' : state.isDone ? 'done' : '';

  return `
    <div class="laundry-card ${stateClass}" data-appliance-id="${a.id}">
      <div class="laundry-card__header">
        <div class="laundry-card__icon">${icon}</div>
        <div class="laundry-card__name">${a.name}</div>
        <span class="laundry-card__status-dot" style="background:${state.color}"></span>
      </div>

      <div class="laundry-card__state" style="color:${state.color}">${state.text}</div>

      ${state.isRunning ? `
        <div class="laundry-card__progress">
          <div class="laundry-card__progress-bar" style="width:${progress}%"></div>
        </div>
      ` : ''}

      ${state.isRunning && timeStr ? `
        <div class="laundry-card__time" data-remain-h="${s.remainHour || 0}" data-remain-m="${s.remainMinute || 0}">
          ${timeStr} remaining
        </div>
      ` : ''}

      ${state.isDone ? `
        <div class="laundry-card__time laundry-card__time--done">
          Cycle complete
        </div>
      ` : ''}

      <div class="laundry-card__data-grid">
        <div class="laundry-data-row">
          <span class="laundry-data-label">Remote Control</span>
          <span class="laundry-data-value">${s.remoteControlEnabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        ${a.model ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">Model</span>
          <span class="laundry-data-value">${a.model}</span>
        </div>
        ` : ''}
      </div>

      <div class="laundry-card__controls">
        <button class="laundry-watch-btn ${watching ? 'active' : ''}"
                onclick="window._toggleWatch(${a.id})"
                title="${watching ? 'Stop watching' : 'Get notified when this cycle ends'}">
          ${BELL_ICON}
          <span>${watching ? 'Watching' : 'Notify When Done'}</span>
        </button>
      </div>

      <div class="laundry-card__sync-time">${formatSyncTime(a.last_synced_at)}</div>
    </div>
  `;
}

// =============================================
// RENDERING — OVEN
// =============================================
function renderOvenCard(oven) {
  const state = getOvenStateDisplay(oven);
  const currentTemp = getCurrentTemp(oven);
  const targetTemp = getTargetTemp(oven);
  const probeTemp = getProbeTemp(oven);
  const timer = getTimerDisplay(oven);
  const door = getDoorStatus(oven);
  const fan = getFanSpeed(oven);
  const steam = getSteamInfo(oven);
  const elements = getHeatingElements(oven);
  const waterEmpty = isWaterTankEmpty(oven);
  const isRefreshing = refreshingOven.has(oven.id);
  const stateClass = state.isCooking ? 'running' : '';
  const bulbMode = oven.last_state?.nodes?.temperatureBulbs?.mode || 'dry';

  return `
    <div class="laundry-card ${stateClass}" data-oven-id="${oven.id}">
      <div class="laundry-card__header">
        <div class="laundry-card__icon">${OVEN_ICON}</div>
        <div class="laundry-card__name">${oven.name}</div>
        <span class="laundry-card__status-dot" style="background:${state.color}"></span>
      </div>

      <div class="laundry-card__state" style="color:${state.color}">${state.text}</div>

      ${timer ? `
        <div class="laundry-card__progress">
          <div class="laundry-card__progress-bar" style="width:${timer.progress}%"></div>
        </div>
        <div class="laundry-card__time">${timer.display} remaining</div>
      ` : ''}

      ${waterEmpty ? `
        <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:var(--radius);padding:0.5rem;font-size:0.8rem;margin:0.5rem 0;color:#92400e;">
          Water tank empty — refill for steam cooking
        </div>
      ` : ''}

      <div class="laundry-card__data-grid">
        ${currentTemp != null ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">Temperature</span>
          <span class="laundry-data-value">${Math.round(currentTemp)}°F${targetTemp != null ? ` / ${Math.round(targetTemp)}°F` : ''}</span>
        </div>
        ` : ''}
        ${probeTemp != null ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">Probe</span>
          <span class="laundry-data-value">${Math.round(probeTemp)}°F</span>
        </div>
        ` : ''}
        <div class="laundry-data-row">
          <span class="laundry-data-label">Mode</span>
          <span class="laundry-data-value" style="text-transform:capitalize;">${bulbMode}</span>
        </div>
        ${door ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">Door</span>
          <span class="laundry-data-value">${door}</span>
        </div>
        ` : ''}
        ${fan != null ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">Fan</span>
          <span class="laundry-data-value">${fan}%</span>
        </div>
        ` : ''}
        ${steam && steam.humidity != null ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">Humidity</span>
          <span class="laundry-data-value">${steam.humidity}%${steam.humidityTarget != null ? ` / ${steam.humidityTarget}%` : ''}</span>
        </div>
        ` : ''}
        ${elements ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">Elements</span>
          <span class="laundry-data-value">${[elements.top && 'Top', elements.bottom && 'Bottom', elements.rear && 'Rear'].filter(Boolean).join(', ') || 'Off'}</span>
        </div>
        ` : ''}
      </div>

      <div class="laundry-card__controls" style="gap:0.5rem;">
        <button class="laundry-watch-btn" onclick="window._refreshOven(${oven.id})" title="Fetch live state from oven"
                ${isRefreshing ? 'disabled' : ''} style="flex:1;">
          ${REFRESH_ICON}
          <span>${isRefreshing ? 'Refreshing...' : 'Refresh'}</span>
        </button>
        ${canControlOven && !state.isCooking ? `
          <button class="laundry-watch-btn" onclick="window._showStartCook(${oven.id})" title="Start cooking" style="flex:1;background:var(--available);color:white;border-color:var(--available);">
            <span>Start Cook</span>
          </button>
        ` : ''}
        ${canControlOven && state.isCooking ? `
          <button class="laundry-watch-btn" onclick="window._stopCook(${oven.id})" title="Stop cooking" style="flex:1;background:var(--occupied);color:white;border-color:var(--occupied);">
            <span>Stop</span>
          </button>
        ` : ''}
      </div>

      <div class="laundry-card__sync-time">${formatOvenSyncTime(oven.last_synced_at)}</div>
    </div>
  `;
}

// =============================================
// RENDERING — GLOWFORGE
// =============================================
function renderGlowforgeCard(machine) {
  const state = getMachineStateDisplay(machine);
  const lastActivity = getLastActivity(machine);
  const model = getMachineModel(machine);
  const stateClass = state.isOnline ? 'running' : '';

  return `
    <div class="laundry-card ${stateClass}" data-glowforge-id="${machine.id}">
      <div class="laundry-card__header">
        <div class="laundry-card__icon">${GLOWFORGE_ICON}</div>
        <div class="laundry-card__name">${machine.name}</div>
        <span class="laundry-card__status-dot" style="background:${state.color}"></span>
      </div>

      <div class="laundry-card__state" style="color:${state.color}">${state.text}</div>

      <div class="laundry-card__data-grid">
        ${model ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">Model</span>
          <span class="laundry-data-value" style="text-transform:capitalize;">${model}</span>
        </div>
        ` : ''}
        ${lastActivity ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">Last Activity</span>
          <span class="laundry-data-value">${lastActivity}</span>
        </div>
        ` : ''}
      </div>

      <div class="laundry-card__controls">
        <button class="laundry-watch-btn" onclick="window._refreshGlowforge()" title="Fetch live status from Glowforge cloud"
                ${refreshingGlowforge ? 'disabled' : ''} style="flex:1;">
          ${REFRESH_ICON}
          <span>${refreshingGlowforge ? 'Refreshing...' : 'Refresh'}</span>
        </button>
      </div>

      <div class="laundry-card__sync-time">${formatGlowforgeSyncTime(machine.last_synced_at)}</div>
    </div>
  `;
}

// =============================================
// RENDERING — 3D PRINTER
// =============================================
function renderPrinterCard(printer) {
  const state = getPrinterStateDisplay(printer);
  const nozzle = getNozzleTemp(printer);
  const bed = getBedTemp(printer);
  const progress = getPrintProgress(printer);
  const ledOn = isLedOn(printer);
  const isRefreshing = refreshingPrinter.has(printer.id);
  const stateClass = state.isPrinting ? 'running' : '';

  return `
    <div class="laundry-card ${stateClass}" data-printer-id="${printer.id}">
      <div class="laundry-card__header">
        <div class="laundry-card__icon">${PRINTER_ICON}</div>
        <div class="laundry-card__name">${printer.name}</div>
        <span class="laundry-card__status-dot" style="background:${state.color}"></span>
      </div>

      <div class="laundry-card__state" style="color:${state.color}">${state.text}</div>

      ${progress ? `
        <div class="laundry-card__progress">
          <div class="laundry-card__progress-bar" style="width:${progress.percent}%"></div>
        </div>
        <div class="laundry-card__time">${progress.percent}%${progress.filename ? ` — ${progress.filename}` : ''}</div>
      ` : ''}

      <div class="laundry-card__data-grid">
        ${nozzle ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">Nozzle</span>
          <span class="laundry-data-value">${Math.round(nozzle.current)}°C${nozzle.target > 0 ? ` / ${Math.round(nozzle.target)}°C` : ''}</span>
        </div>
        ` : ''}
        ${bed ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">Bed</span>
          <span class="laundry-data-value">${Math.round(bed.current)}°C${bed.target > 0 ? ` / ${Math.round(bed.target)}°C` : ''}</span>
        </div>
        ` : ''}
        ${printer.machine_type ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">Model</span>
          <span class="laundry-data-value">${printer.machine_type}</span>
        </div>
        ` : ''}
        ${ledOn != null ? `
        <div class="laundry-data-row">
          <span class="laundry-data-label">LED</span>
          <span class="laundry-data-value">${ledOn ? 'On' : 'Off'}</span>
        </div>
        ` : ''}
      </div>

      <div class="laundry-card__controls" style="gap:0.5rem;">
        <button class="laundry-watch-btn" onclick="window._refreshPrinter('${printer.id}')" title="Fetch live status"
                ${isRefreshing ? 'disabled' : ''} style="flex:1;">
          ${REFRESH_ICON}
          <span>${isRefreshing ? 'Refreshing...' : 'Refresh'}</span>
        </button>
        ${canControlPrinter && ledOn != null ? `
          <button class="laundry-watch-btn" onclick="window._togglePrinterLight('${printer.id}')" title="Toggle LED light" style="flex:0 0 auto;min-width:50px;">
            <span>${ledOn ? '💡' : '🔲'}</span>
          </button>
        ` : ''}
      </div>
      ${canControlPrinter && state.isPrinting ? `
      <div class="laundry-card__controls" style="gap:0.5rem;margin-top:0.25rem;">
        ${state.text === 'Paused' ? `
          <button class="laundry-watch-btn" onclick="window._resumePrint('${printer.id}')" style="flex:1;background:var(--available);color:white;border-color:var(--available);">
            <span>Resume</span>
          </button>
        ` : `
          <button class="laundry-watch-btn" onclick="window._pausePrint('${printer.id}')" style="flex:1;background:#f59e0b;color:white;border-color:#f59e0b;">
            <span>Pause</span>
          </button>
        `}
        <button class="laundry-watch-btn" onclick="window._cancelPrint('${printer.id}')" style="flex:1;background:var(--occupied);color:white;border-color:var(--occupied);">
          <span>Cancel</span>
        </button>
      </div>
      ` : ''}

      <div class="laundry-card__sync-time">${formatPrinterSyncTime(printer.last_synced_at)}</div>
    </div>
  `;
}

// =============================================
// RENDERING — SECTIONS
// =============================================
function renderSections() {
  const container = document.getElementById('applianceSections');
  if (!container) return;

  // Laundry section
  const laundryOpen = getSectionOpenState('laundry');
  let laundryCardsHtml;
  if (appliances.length > 0) {
    laundryCardsHtml = `<div class="laundry-grid">${appliances.map(renderLaundryCard).join('')}</div>`;
  } else if (loadFailed) {
    laundryCardsHtml = `<div style="text-align:center;padding:2rem;color:var(--text-muted);">
      <p>Unable to load appliance data. Check your connection and try again.</p>
    </div>`;
  } else {
    laundryCardsHtml = `<p style="text-align:center;color:var(--text-muted);padding:2rem;">
      No laundry appliances configured yet. An admin needs to set up the LG ThinQ connection in Settings below.
    </p>`;
  }

  // Cooking section
  const cookingOpen = getSectionOpenState('cooking');
  let cookingCardsHtml;
  if (anovaOvens.length > 0) {
    cookingCardsHtml = `<div class="laundry-grid">${anovaOvens.map(renderOvenCard).join('')}</div>`;
  } else {
    cookingCardsHtml = `<p style="text-align:center;color:var(--text-muted);padding:2rem;">
      No ovens discovered yet. Admin: add your Anova PAT in Settings below, then click Refresh.
    </p>`;
  }

  // Maker Tools section (Glowforge)
  const makerOpen = getSectionOpenState('maker');
  let makerCardsHtml;
  if (glowforgeMachines.length > 0) {
    makerCardsHtml = `<div class="laundry-grid">${glowforgeMachines.map(renderGlowforgeCard).join('')}</div>`;
  } else {
    makerCardsHtml = `<p style="text-align:center;color:var(--text-muted);padding:2rem;">
      No maker tools discovered yet. Admin: configure Glowforge credentials in Settings below, then click Refresh.
    </p>`;
  }

  // 3D Printing section
  const printingOpen = getSectionOpenState('printing');
  let printerCardsHtml;
  if (printerDevices.length > 0) {
    printerCardsHtml = `<div class="laundry-grid">${printerDevices.map(renderPrinterCard).join('')}</div>`;
  } else {
    printerCardsHtml = `<p style="text-align:center;color:var(--text-muted);padding:2rem;">
      No 3D printers discovered yet. Admin: configure the printer proxy URL in Settings below.
    </p>`;
  }

  container.innerHTML = `
    <details class="appliance-section" ${laundryOpen ? 'open' : ''} data-section="laundry">
      <summary class="appliance-section__header">
        <span class="appliance-section__chevron"></span>
        <h3>Laundry</h3>
        <span class="appliance-section__count">${appliances.length} appliance${appliances.length !== 1 ? 's' : ''}</span>
      </summary>
      <div class="appliance-section__body">
        ${laundryCardsHtml}
        ${appliances.some(a => a.device_type === 'washer') ? `
        <div class="laundry-qr" style="text-align:center;padding:1.5rem 1rem 1rem;border-top:1px solid #e5e2dc;margin-top:1rem;">
          <img src="washer-qr.svg" alt="Scan to get washer notifications" style="width:120px;height:120px;margin:0 auto;">
          <p style="margin:0.5rem 0 0;font-size:0.8rem;color:var(--text-muted);">Scan to get notified when the washer is done</p>
        </div>
        ` : ''}
      </div>
    </details>

    <details class="appliance-section" ${cookingOpen ? 'open' : ''} data-section="cooking">
      <summary class="appliance-section__header">
        <span class="appliance-section__chevron"></span>
        <h3>Cooking</h3>
        <span class="appliance-section__count">${anovaOvens.length} oven${anovaOvens.length !== 1 ? 's' : ''}</span>
      </summary>
      <div class="appliance-section__body">
        ${cookingCardsHtml}
      </div>
    </details>

    <details class="appliance-section" ${printingOpen ? 'open' : ''} data-section="printing">
      <summary class="appliance-section__header">
        <span class="appliance-section__chevron"></span>
        <h3>3D Printing</h3>
        <span class="appliance-section__count">${printerDevices.length} printer${printerDevices.length !== 1 ? 's' : ''}</span>
      </summary>
      <div class="appliance-section__body">
        ${printerCardsHtml}
      </div>
    </details>

    <details class="appliance-section" ${makerOpen ? 'open' : ''} data-section="maker">
      <summary class="appliance-section__header">
        <span class="appliance-section__chevron"></span>
        <h3>Maker Tools</h3>
        <span class="appliance-section__count">${glowforgeMachines.length} device${glowforgeMachines.length !== 1 ? 's' : ''}</span>
      </summary>
      <div class="appliance-section__body">
        ${makerCardsHtml}
      </div>
    </details>
  `;

  // Collapse state persistence
  container.querySelectorAll('.appliance-section').forEach(details => {
    details.addEventListener('toggle', () => {
      saveSectionState(details.dataset.section, details.open);
    });
  });
}

// =============================================
// OVEN CONTROLS
// =============================================
window._refreshOven = async function(ovenId) {
  if (refreshingOven.has(ovenId)) return;
  refreshingOven.add(ovenId);
  renderSections();

  try {
    const result = await refreshOvenState(ovenId);
    if (result.error) throw new Error(result.error);
    showToast('Oven state updated', 'success');
    await loadAnovaOvens();
  } catch (err) {
    showToast(`Refresh failed: ${err.message}`, 'error');
  } finally {
    refreshingOven.delete(ovenId);
    renderSections();
  }
};

window._showStartCook = function(ovenId) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:400px;">
      <div class="modal-header">
        <h2>Start Cook</h2>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:1rem;padding:1rem;">
        <div>
          <label style="font-weight:600;display:block;margin-bottom:0.25rem;">Temperature (°F)</label>
          <input type="number" id="cookTempInput" value="350" min="75" max="482" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:var(--radius);">
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:0.25rem;">Mode</label>
          <select id="cookModeInput" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:var(--radius);">
            <option value="dry">Dry (Convection)</option>
            <option value="wet">Wet (Steam)</option>
          </select>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:0.25rem;">Timer (minutes, optional)</label>
          <input type="number" id="cookTimerInput" placeholder="e.g. 30" min="1" max="1440" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:var(--radius);">
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:0.25rem;">Fan Speed (%)</label>
          <input type="number" id="cookFanInput" value="100" min="0" max="100" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:var(--radius);">
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:0.25rem;">Steam (%)</label>
          <input type="number" id="cookSteamInput" placeholder="0-100, leave empty for none" min="0" max="100" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:var(--radius);">
        </div>
        <button class="btn-primary" id="cookStartBtn" style="padding:0.75rem;">Start Cooking</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  document.getElementById('cookStartBtn').addEventListener('click', async () => {
    const tempF = parseInt(document.getElementById('cookTempInput').value) || 350;
    const mode = document.getElementById('cookModeInput').value;
    const timerMin = parseInt(document.getElementById('cookTimerInput').value) || null;
    const fanSpeed = parseInt(document.getElementById('cookFanInput').value) ?? 100;
    const steamPct = document.getElementById('cookSteamInput').value ? parseInt(document.getElementById('cookSteamInput').value) : null;

    const btn = document.getElementById('cookStartBtn');
    btn.disabled = true;
    btn.textContent = 'Starting...';

    try {
      const stages = buildSimpleCookStages({
        temperatureF: tempF,
        mode,
        timerMinutes: timerMin,
        fanSpeed,
        steamPercent: steamPct,
      });
      const result = await startCook(ovenId, stages);
      if (result.error) throw new Error(result.error);
      showToast(`Oven starting: ${tempF}°F ${mode}${timerMin ? `, ${timerMin}m` : ''}`, 'success');
      modal.remove();
      // Refresh state after a short delay
      setTimeout(() => window._refreshOven(ovenId), 3000);
    } catch (err) {
      showToast(`Start failed: ${err.message}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Start Cooking';
    }
  });
};

// =============================================
// GLOWFORGE CONTROLS
// =============================================
window._refreshGlowforge = async function() {
  if (refreshingGlowforge) return;
  refreshingGlowforge = true;
  renderSections();

  try {
    const result = await refreshGlowforgeStatus();
    if (result.error) throw new Error(result.error);
    showToast(`Glowforge: found ${result.count || 0} machine(s)`, 'success');
    await loadGlowforge();
  } catch (err) {
    showToast(`Glowforge refresh failed: ${err.message}`, 'error');
  } finally {
    refreshingGlowforge = false;
    renderSections();
  }
};

window._stopCook = async function(ovenId) {
  if (!confirm('Stop the oven?')) return;
  try {
    const result = await stopCook(ovenId);
    if (result.error) throw new Error(result.error);
    showToast('Oven stopped', 'success');
    setTimeout(() => window._refreshOven(ovenId), 2000);
  } catch (err) {
    showToast(`Stop failed: ${err.message}`, 'error');
  }
};

// =============================================
// PRINTER CONTROLS
// =============================================
window._refreshPrinter = async function(printerId) {
  if (refreshingPrinter.has(printerId)) return;
  refreshingPrinter.add(printerId);
  renderSections();

  try {
    const result = await refreshPrinterStatus(printerId);
    if (result.error) throw new Error(result.error);
    showToast('Printer status updated', 'success');
    await loadPrinterDevices();
  } catch (err) {
    showToast(`Refresh failed: ${err.message}`, 'error');
  } finally {
    refreshingPrinter.delete(printerId);
    renderSections();
  }
};

window._togglePrinterLight = async function(printerId) {
  const printer = printerDevices.find(p => p.id === printerId);
  const currentlyOn = isLedOn(printer);
  try {
    const result = await toggleLight(printerId, !currentlyOn);
    if (result.error) throw new Error(result.error);
    showToast(`LED ${!currentlyOn ? 'on' : 'off'}`, 'success');
    setTimeout(() => window._refreshPrinter(printerId), 1500);
  } catch (err) {
    showToast(`Toggle failed: ${err.message}`, 'error');
  }
};

window._pausePrint = async function(printerId) {
  try {
    const result = await pausePrint(printerId);
    if (result.error) throw new Error(result.error);
    showToast('Print paused', 'success');
    setTimeout(() => window._refreshPrinter(printerId), 2000);
  } catch (err) {
    showToast(`Pause failed: ${err.message}`, 'error');
  }
};

window._resumePrint = async function(printerId) {
  try {
    const result = await resumePrint(printerId);
    if (result.error) throw new Error(result.error);
    showToast('Print resumed', 'success');
    setTimeout(() => window._refreshPrinter(printerId), 2000);
  } catch (err) {
    showToast(`Resume failed: ${err.message}`, 'error');
  }
};

window._cancelPrint = async function(printerId) {
  if (!confirm('Cancel the current print?')) return;
  try {
    const result = await cancelPrint(printerId);
    if (result.error) throw new Error(result.error);
    showToast('Print cancelled', 'success');
    setTimeout(() => window._refreshPrinter(printerId), 2000);
  } catch (err) {
    showToast(`Cancel failed: ${err.message}`, 'error');
  }
};

// =============================================
// WATCH / UNWATCH (laundry)
// =============================================
window._toggleWatch = async function(applianceId) {
  const isWatching = watchedAppliances.has(applianceId);
  const action = isWatching ? 'unwatch' : 'watch';

  try {
    const { data, error } = await supabase.functions.invoke('lg-control', {
      body: { action, applianceId },
    });

    if (error) throw new Error(error.message);
    if (data?.error) throw new Error(data.error);

    if (action === 'watch') {
      watchedAppliances.add(applianceId);
      showToast("You'll be notified when this cycle ends!", 'success');
    } else {
      watchedAppliances.delete(applianceId);
      showToast('Notification cancelled', 'info');
    }
    renderSections();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
};

// =============================================
// URL PARAMETER HANDLING (?watch=washer or ?watch=dryer)
// =============================================
async function handleWatchParam() {
  const params = new URLSearchParams(window.location.search);
  const watchType = params.get('watch');
  if (!watchType || !currentAppUserId) return;

  window.history.replaceState({}, '', window.location.pathname);

  const target = appliances.find(a => a.device_type === watchType);
  if (!target) {
    showToast(`No ${watchType} found`, 'error');
    return;
  }

  if (watchedAppliances.has(target.id)) {
    showToast(`Already watching the ${watchType}`, 'info');
    return;
  }

  await window._toggleWatch(target.id);
}

// =============================================
// COUNTDOWN TIMER (client-side interpolation)
// =============================================
function startCountdown() {
  stopCountdown();
  countdownTimer = setInterval(() => {
    const timeEls = document.querySelectorAll('.laundry-card__time[data-remain-h]');
    timeEls.forEach(el => {
      let h = parseInt(el.dataset.remainH) || 0;
      let m = parseInt(el.dataset.remainM) || 0;
      const totalSec = h * 3600 + m * 60 - 1;
      if (totalSec <= 0) return;
      const newH = Math.floor(totalSec / 3600);
      const newM = Math.floor((totalSec % 3600) / 60);
      el.dataset.remainH = newH;
      el.dataset.remainM = newM;
      const display = newH > 0 ? `${newH}h ${newM}m` : `${newM}m`;
      el.textContent = `${display} remaining`;
    });
  }, 60000);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

// =============================================
// POLLING
// =============================================
async function refreshFromDB() {
  await Promise.all([loadAppliances(), loadAnovaOvens(), loadGlowforge(), loadPrinterDevices()]);
  await loadWatcherStatus();
  renderSections();
}

// =============================================
// ADMIN SETTINGS — LG
// =============================================
async function renderLgSettings() {
  const container = document.getElementById('lgSettingsContent');
  if (!container) return;

  const { data: config } = await supabase
    .from('lg_config')
    .select('*')
    .eq('id', 1)
    .single();

  const c = config || {};
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:1rem;max-width:600px;">
      <div>
        <label style="font-weight:600;display:block;margin-bottom:0.25rem;">LG ThinQ PAT</label>
        <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem;">
          Generate at <a href="https://connect-pat.lgthinq.com/" target="_blank" rel="noopener">connect-pat.lgthinq.com</a>
        </p>
        <input type="password" id="lgPatInput" value="${c.pat || ''}"
               placeholder="Paste your Personal Access Token"
               style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:var(--radius);font-size:0.9rem;">
      </div>
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <label style="font-weight:600;">Test Mode</label>
        <input type="checkbox" id="lgTestMode" ${c.test_mode ? 'checked' : ''}>
        <span style="font-size:0.8rem;color:var(--text-muted);">When enabled, no API calls are made</span>
      </div>
      ${c.last_error ? `
        <div style="background:var(--occupied-bg);border:1px solid var(--occupied);border-radius:var(--radius);padding:0.75rem;font-size:0.85rem;">
          <strong>Last Error:</strong> ${c.last_error}
        </div>
      ` : ''}
      <div>
        <button id="lgSaveBtn" class="btn-primary" style="padding:0.5rem 1.5rem;">Save Settings</button>
      </div>
    </div>
  `;

  document.getElementById('lgSaveBtn')?.addEventListener('click', async () => {
    const pat = document.getElementById('lgPatInput')?.value?.trim();
    const testMode = document.getElementById('lgTestMode')?.checked;

    const { error } = await supabase
      .from('lg_config')
      .update({ pat: pat || null, test_mode: testMode, updated_at: new Date().toISOString() })
      .eq('id', 1);

    if (error) showToast(`Save failed: ${error.message}`, 'error');
    else showToast('LG ThinQ settings saved', 'success');
  });
}

// =============================================
// ADMIN SETTINGS — ANOVA
// =============================================
async function renderAnovaSettings() {
  const container = document.getElementById('anovaSettingsContent');
  if (!container) return;

  const { data: config } = await supabase
    .from('anova_config')
    .select('*')
    .eq('id', 1)
    .single();

  const c = config || {};
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:1rem;max-width:600px;">
      <div>
        <label style="font-weight:600;display:block;margin-bottom:0.25rem;">Anova PAT</label>
        <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem;">
          Generate in the Anova Oven app: More > Developer > Personal Access Tokens
        </p>
        <input type="password" id="anovaPatInput" value="${c.pat || ''}"
               placeholder="anova-xxxx..."
               style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:var(--radius);font-size:0.9rem;">
      </div>
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <label style="font-weight:600;">Test Mode</label>
        <input type="checkbox" id="anovaTestMode" ${c.test_mode ? 'checked' : ''}>
        <span style="font-size:0.8rem;color:var(--text-muted);">When enabled, no API calls are made</span>
      </div>
      ${c.last_error ? `
        <div style="background:var(--occupied-bg);border:1px solid var(--occupied);border-radius:var(--radius);padding:0.75rem;font-size:0.85rem;">
          <strong>Last Error:</strong> ${c.last_error}
        </div>
      ` : ''}
      ${c.last_synced_at ? `
        <div style="font-size:0.8rem;color:var(--text-muted);">Last synced: ${formatOvenSyncTime(c.last_synced_at)}</div>
      ` : ''}
      <div style="display:flex;gap:0.75rem;">
        <button id="anovaSaveBtn" class="btn-primary" style="padding:0.5rem 1.5rem;">Save Settings</button>
        <button id="anovaTestBtn" class="btn-secondary" style="padding:0.5rem 1.5rem;">Test Connection</button>
      </div>
      <div id="anovaDeviceList"></div>
    </div>
  `;

  document.getElementById('anovaSaveBtn')?.addEventListener('click', async () => {
    const pat = document.getElementById('anovaPatInput')?.value?.trim();
    const testMode = document.getElementById('anovaTestMode')?.checked;

    const { error } = await supabase
      .from('anova_config')
      .update({ pat: pat || null, test_mode: testMode, updated_at: new Date().toISOString() })
      .eq('id', 1);

    if (error) showToast(`Save failed: ${error.message}`, 'error');
    else showToast('Anova settings saved', 'success');
  });

  document.getElementById('anovaTestBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('anovaTestBtn');
    btn.disabled = true;
    btn.textContent = 'Connecting...';
    try {
      const result = await refreshOvenState();
      if (result.error) throw new Error(result.error);
      showToast(`Connected! Found oven (${result.ovenType})`, 'success');
      await loadAnovaOvens();
      renderSections();
      renderAnovaSettings(); // refresh device list
    } catch (err) {
      showToast(`Connection failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test Connection';
    }
  });

  // Show discovered ovens
  if (anovaOvens.length > 0) {
    const deviceList = document.getElementById('anovaDeviceList');
    if (deviceList) {
      deviceList.innerHTML = `
        <div style="margin-top:0.5rem;">
          <label style="font-weight:600;display:block;margin-bottom:0.5rem;">Discovered Ovens</label>
          ${anovaOvens.map(o => `
            <div style="padding:0.5rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:0.5rem;">
              <div style="font-weight:600;">${o.name}</div>
              <div style="font-size:0.8rem;color:var(--text-muted);">
                ID: ${o.cooker_id} | Type: ${o.oven_type || '?'}${o.firmware_version ? ` | FW: ${o.firmware_version}` : ''} | IP: ${o.lan_ip || '?'}
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }
  }
}

// =============================================
// ADMIN SETTINGS — GLOWFORGE
// =============================================
async function renderGlowforgeSettings() {
  const container = document.getElementById('glowforgeSettingsContent');
  if (!container) return;

  const { data: config } = await supabase
    .from('glowforge_config')
    .select('*')
    .eq('id', 1)
    .single();

  const c = config || {};
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:1rem;max-width:600px;">
      <p style="font-size:0.85rem;color:var(--text-muted);margin:0;">
        Credentials stored as Supabase secrets (GLOWFORGE_EMAIL, GLOWFORGE_PASSWORD).
      </p>
      ${c.last_error ? `
        <div style="background:var(--occupied-bg);border:1px solid var(--occupied);border-radius:var(--radius);padding:0.75rem;font-size:0.85rem;">
          <strong>Last Error:</strong> ${c.last_error}
        </div>
      ` : ''}
      ${c.last_synced_at ? `
        <div style="font-size:0.8rem;color:var(--text-muted);">Last synced: ${formatGlowforgeSyncTime(c.last_synced_at)}</div>
      ` : ''}
      <div>
        <button id="gfTestBtn" class="btn-secondary" style="padding:0.5rem 1.5rem;">Test Connection</button>
      </div>
      <div id="gfDeviceList"></div>
    </div>
  `;

  document.getElementById('gfTestBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('gfTestBtn');
    btn.disabled = true;
    btn.textContent = 'Connecting...';
    try {
      const result = await refreshGlowforgeStatus();
      if (result.error) throw new Error(result.error);
      showToast(`Connected! Found ${result.count || 0} machine(s)`, 'success');
      await loadGlowforge();
      renderSections();
      renderGlowforgeSettings(); // refresh device list
    } catch (err) {
      showToast(`Connection failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test Connection';
    }
  });

  // Show discovered machines
  if (glowforgeMachines.length > 0) {
    const deviceList = document.getElementById('gfDeviceList');
    if (deviceList) {
      deviceList.innerHTML = `
        <div style="margin-top:0.5rem;">
          <label style="font-weight:600;display:block;margin-bottom:0.5rem;">Discovered Machines</label>
          ${glowforgeMachines.map(m => `
            <div style="padding:0.5rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:0.5rem;">
              <div style="font-weight:600;">${m.name}</div>
              <div style="font-size:0.8rem;color:var(--text-muted);">
                ID: ${m.machine_id || '?'} | Type: ${m.machine_type || '?'}${m.lan_ip ? ` | IP: ${m.lan_ip}` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }
  }
}

// =============================================
// ADMIN SETTINGS — 3D PRINTER
// =============================================
async function renderPrinterSettings() {
  const container = document.getElementById('printerSettingsContent');
  if (!container) return;

  const { data: config } = await supabase
    .from('printer_config')
    .select('*')
    .eq('id', 1)
    .single();

  const c = config || {};
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:1rem;max-width:600px;">
      <div>
        <label style="font-weight:600;display:block;margin-bottom:0.25rem;">Proxy URL</label>
        <input type="text" id="printerProxyUrl" value="${c.proxy_url || ''}" placeholder="https://ai-admin.cloud/printer-proxy" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:var(--radius);font-size:0.9rem;">
        <p style="font-size:0.75rem;color:var(--text-muted);margin:0.25rem 0 0;">URL to the printer proxy on Property Mac (via Caddy/Tailscale).</p>
      </div>
      <div>
        <label style="font-weight:600;display:block;margin-bottom:0.25rem;">Proxy Secret</label>
        <input type="password" id="printerProxySecret" value="${c.proxy_secret || ''}" placeholder="shared secret" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:var(--radius);font-size:0.9rem;">
      </div>
      <div style="display:flex;gap:1rem;align-items:center;">
        <label><input type="checkbox" id="printerTestMode" ${c.test_mode ? 'checked' : ''}> Test Mode</label>
        <label><input type="checkbox" id="printerIsActive" ${c.is_active !== false ? 'checked' : ''}> Active</label>
      </div>
      ${c.last_error ? `
        <div style="background:var(--occupied-bg);border:1px solid var(--occupied);border-radius:var(--radius);padding:0.75rem;font-size:0.85rem;">
          <strong>Last Error:</strong> ${c.last_error}
        </div>
      ` : ''}
      <div style="display:flex;gap:0.5rem;">
        <button id="printerSaveBtn" class="btn-secondary" style="padding:0.5rem 1.5rem;">Save</button>
        <button id="printerTestBtn" class="btn-secondary" style="padding:0.5rem 1.5rem;">Test Connection</button>
      </div>
      <div id="printerDeviceList"></div>
    </div>
  `;

  document.getElementById('printerSaveBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('printerSaveBtn');
    btn.disabled = true;
    try {
      const { error } = await supabase.from('printer_config').upsert({
        id: 1,
        proxy_url: document.getElementById('printerProxyUrl').value.trim(),
        proxy_secret: document.getElementById('printerProxySecret').value.trim(),
        test_mode: document.getElementById('printerTestMode').checked,
        is_active: document.getElementById('printerIsActive').checked,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      showToast('Printer settings saved', 'success');
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('printerTestBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('printerTestBtn');
    btn.disabled = true;
    btn.textContent = 'Connecting...';
    try {
      const printer = printerDevices[0];
      if (!printer) throw new Error('No printer devices configured');
      const result = await refreshPrinterStatus(printer.id);
      if (result.error) throw new Error(result.error);
      showToast('Connected! Printer status refreshed.', 'success');
      await loadPrinterDevices();
      renderSections();
      renderPrinterSettings();
    } catch (err) {
      showToast(`Connection failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test Connection';
    }
  });

  // Show discovered printers
  if (printerDevices.length > 0) {
    const deviceList = document.getElementById('printerDeviceList');
    if (deviceList) {
      deviceList.innerHTML = `
        <div style="margin-top:0.5rem;">
          <label style="font-weight:600;display:block;margin-bottom:0.5rem;">Configured Printers</label>
          ${printerDevices.map(p => `
            <div style="padding:0.5rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:0.5rem;">
              <div style="font-weight:600;">${p.name}</div>
              <div style="font-size:0.8rem;color:var(--text-muted);">
                SN: ${p.serial_number || '?'} | Type: ${p.machine_type || '?'}${p.firmware_version ? ` | FW: ${p.firmware_version}` : ''} | IP: ${p.lan_ip || '?'}
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }
  }
}

// =============================================
// INIT
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  initResidentPage({
    activeTab: 'devices',
    requiredRole: 'resident',
    onReady: async (authState) => {
      currentUserRole = authState.appUser?.role;
      currentAppUserId = authState.appUser?.id;
      deviceScope = await getResidentDeviceScope(authState.appUser, authState.hasPermission);
      canControlOven = hasPermission('control_oven');
      canControlPrinter = hasPermission('control_printer');

      // Initial load + polling
      await refreshFromDB();

      // Show admin settings sections
      const showLgAdmin = hasPermission('admin_laundry_settings');
      const showOvenAdmin = hasPermission('admin_oven_settings');
      const showGfAdmin = hasPermission('admin_glowforge_settings');
      const showPrinterAdmin = hasPermission('admin_printer_settings');
      if (showLgAdmin || showOvenAdmin || showGfAdmin || showPrinterAdmin) {
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
        if (showLgAdmin) await renderLgSettings();
        if (showOvenAdmin) await renderAnovaSettings();
        if (showGfAdmin) await renderGlowforgeSettings();
        if (showPrinterAdmin) await renderPrinterSettings();
      }

      poll = new PollManager(refreshFromDB, POLL_INTERVAL_MS);
      poll.start();
      startCountdown();

      await handleWatchParam();
    },
  });
});
