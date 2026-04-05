/**
 * Sonos Music Page
 * Shows zone groups with playback controls, a music library sidebar
 * with starred playlists, ambient group, and drag-and-drop playback.
 * Also supports room grouping/ungrouping and scheduled playback alarms.
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
const SONOS_CONTROL_URL = `${SUPABASE_URL}/functions/v1/sonos-control`;
const POLL_INTERVAL_MS = 30000;

// =============================================
// STATE
// =============================================
let zoneGroups = [];       // Array of { coordinatorName, coordinatorState, groupState, members[] }
let playlists = [];        // Array of playlist name strings
let favorites = [];        // Array of favorite name strings
let playlistTags = [];     // Array of { playlist_name, tag } from DB
let schedules = [];        // Array of schedule objects from DB
let poll = null;
let elapsedTimer = null;
let volumeTimers = {};
let balanceState = {};    // { roomName: value } — persisted locally since Sonos doesn't expose balance
let dragItem = null;       // { type: 'playlist'|'favorite'|'spotify', name: string, spotifyQuery?, spotifySearchType? }
let pendingLibraryItem = null;
let userRole = null;       // 'admin', 'staff', 'resident', 'associate'
let groupingMode = false;
let groupingSelected = []; // room names selected for grouping
let scenes = [];           // Array of scene objects from DB (with nested actions)
let activatingScene = null; // ID of scene currently being activated
let deviceScope = null;
let uxActiveTab = 'now';

// =============================================
// INITIALIZATION
// =============================================
document.addEventListener('DOMContentLoaded', async () => {
  await initResidentPage({
    activeTab: 'devices',
    requiredRole: 'resident',
    onReady: async (state) => {
      userRole = state.appUser?.role;
      deviceScope = await getResidentDeviceScope(state.appUser, state.hasPermission);
      if (hasPermission('admin_music_settings')) {
        document.body.classList.add('is-staff');
      }
      loadBalanceState();
      loadUxTabPreference();
      setupEventListeners();
      setupSpotifySearch();

      // Load zone-independent DB data in parallel with zones (which may be slow)
      const zonesReady = loadZones().then(() => {
        renderZones();
      });
      const dbReady = Promise.all([loadPlaylistTags(), loadSchedules(), loadScenes()]).then(() => {
        renderSchedules();
        renderScenesSection();
      });

      // Wait for zones + DB data before loading zone-dependent data
      await Promise.all([zonesReady, dbReady]);

      // Load zone-dependent data (playlists/favorites need a coordinator room)
      await Promise.all([loadPlaylists(), loadFavorites()]);
      renderMusicLibrary();
      renderSceneBar();
      renderNowAmbient();
      startPolling();
      // Refresh when PAI takes music actions
      window.addEventListener('pai-actions', (e) => {
        const musicActions = (e.detail?.actions || []).filter(a => a.type === 'control_sonos');
        if (musicActions.length) setTimeout(() => refreshAllZones(), 1500);
      });
    },
  });
});

// =============================================
// API WRAPPER
// =============================================
const SONOS_API_TIMEOUT_MS = 15000;

async function sonosApi(action, params = {}) {
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SONOS_API_TIMEOUT_MS);

  try {
    const response = await fetch(SONOS_CONTROL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ action, ...params }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Request failed' }));
      const msg = typeof err.error === 'string' ? err.error
        : err.message || err.response || JSON.stringify(err.error || err);
      throw new Error(msg);
    }

    return response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Sonos API timed out (${action})`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================
// DATA LOADING
// =============================================
async function loadZones() {
  try {
    const result = await sonosApi('getZones');
    zoneGroups = [];
    if (!Array.isArray(result)) return;

    for (const group of result) {
      const coord = group.coordinator;
      const members = group.members || [];
      let visibleMembers = members;

      if (deviceScope && !deviceScope.fullAccess) {
        if (!deviceScope.canAccessSpaceName(coord?.roomName)) continue;
        visibleMembers = members.filter((member) => deviceScope.canAccessSpaceName(member?.roomName));
        if (!visibleMembers.length) continue;
      }

      zoneGroups.push({
        coordinatorName: coord.roomName,
        coordinatorState: coord.state,
        groupState: coord.groupState,
        members: visibleMembers.map(m => ({
          roomName: m.roomName,
          volume: m.state?.volume ?? 0,
          mute: m.state?.mute ?? false,
          isCoordinator: m.roomName === coord.roomName,
          bass: m.state?.equalizer?.bass ?? 0,
          treble: m.state?.equalizer?.treble ?? 0,
        })),
      });
    }

    // Sort: playing first, then paused, then stopped, then alphabetically
    const stateOrder = { PLAYING: 0, PAUSED_PLAYBACK: 1, TRANSITIONING: 2, STOPPED: 3 };
    zoneGroups.sort((a, b) => {
      const aOrder = stateOrder[a.coordinatorState?.playbackState] ?? 3;
      const bOrder = stateOrder[b.coordinatorState?.playbackState] ?? 3;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.coordinatorName.localeCompare(b.coordinatorName);
    });
  } catch (err) {
    console.error('Failed to load zones:', err);
    showToast('Failed to load Sonos zones', 'error');
  }
}

async function loadPlaylists() {
  try {
    if (!zoneGroups.length) return;
    const result = await sonosApi('playlists', { room: zoneGroups[0].coordinatorName });
    playlists = Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('Failed to load playlists:', err);
  }
}

async function loadFavorites() {
  try {
    if (!zoneGroups.length) return;
    const result = await sonosApi('favorites', { room: zoneGroups[0].coordinatorName });
    favorites = Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('Failed to load favorites:', err);
  }
}

async function loadPlaylistTags() {
  try {
    const { data, error } = await supabase
      .from('sonos_playlist_tags')
      .select('playlist_name, tag');
    if (!error) playlistTags = data || [];
  } catch (err) {
    console.error('Failed to load playlist tags:', err);
  }
}

async function loadSchedules() {
  try {
    const { data, error } = await supabase
      .from('sonos_schedules')
      .select('*')
      .order('time_of_day', { ascending: true });
    if (!error) schedules = data || [];
  } catch (err) {
    console.error('Failed to load schedules:', err);
  }
}

async function loadScenes() {
  try {
    const { data, error } = await supabase
      .from('sonos_scenes')
      .select('*, sonos_scene_actions(*)')
      .eq('is_active', true)
      .order('display_order', { ascending: true });
    if (!error) scenes = data || [];
  } catch (err) {
    console.error('Failed to load scenes:', err);
  }
}

// =============================================
// HELPERS
// =============================================
function isLocalArtUrl(url) {
  if (!url) return true;
  return /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost)/.test(url);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function isStaffPlus() {
  return hasPermission('admin_music_settings');
}

function isPlaylistStarred(name) {
  return playlistTags.some(t => t.playlist_name === name && t.tag === 'favorite');
}

function getAllRoomNames() {
  const rooms = [];
  for (const g of zoneGroups) {
    for (const m of g.members) {
      rooms.push(m.roomName);
    }
  }
  return [...new Set(rooms)].sort();
}

function loadUxTabPreference() {
  try {
    const saved = localStorage.getItem('sonos_ux_tab');
    if (saved === 'now' || saved === 'ambient') uxActiveTab = saved;
  } catch {}
}

function saveUxTabPreference() {
  try {
    localStorage.setItem('sonos_ux_tab', uxActiveTab);
  } catch {}
}

function getAmbientPlaylists() {
  const ambientOnly = playlists.filter(name => /ambient/i.test(name));
  if (ambientOnly.length > 0) return [...new Set(ambientOnly)].sort();
  return [];
}

function getTargetRooms() {
  return zoneGroups.map(g => g.coordinatorName).sort((a, b) => a.localeCompare(b));
}

function getSelectedAmbientTargetRoom() {
  const selected = document.getElementById('uxAmbientTarget')?.value;
  if (selected) return selected;
  return getTargetRooms()[0] || null;
}

function renderNowAmbient() {
  const nowBtn = document.getElementById('uxNowTabBtn');
  const ambientBtn = document.getElementById('uxAmbientTabBtn');
  const nowPanel = document.getElementById('uxNowPanel');
  const ambientPanel = document.getElementById('uxAmbientPanel');
  if (!nowPanel || !ambientPanel) return;

  renderNowPanel();
  renderAmbientPanel();

  const showNow = uxActiveTab !== 'ambient';
  nowPanel.classList.toggle('hidden', !showNow);
  ambientPanel.classList.toggle('hidden', showNow);

  if (nowBtn && ambientBtn) {
    nowBtn.className = showNow
      ? 'rounded-aap px-3 py-1.5 text-sm font-semibold text-aap-dark bg-aap-amber shadow-aap-sm'
      : 'rounded-aap px-3 py-1.5 text-sm font-medium text-white/80 hover:bg-white/10';
    ambientBtn.className = !showNow
      ? 'rounded-aap px-3 py-1.5 text-sm font-semibold text-aap-dark bg-aap-amber shadow-aap-sm'
      : 'rounded-aap px-3 py-1.5 text-sm font-medium text-white/80 hover:bg-white/10';
  }

  saveUxTabPreference();
}

function renderNowPanel() {
  const panel = document.getElementById('uxNowPanel');
  if (!panel) return;

  if (!zoneGroups.length) {
    panel.innerHTML = '<p class="rounded-aap-lg border border-white/30 bg-white/90 p-4 text-sm text-aap-text-muted">No available zones right now.</p>';
    return;
  }

  const cards = zoneGroups.map(group => {
    const state = group.coordinatorState || {};
    const track = state.currentTrack || {};
    const isPlaying = state.playbackState === 'PLAYING';
    const displayState = isPlaying ? 'Playing' : (state.playbackState === 'PAUSED_PLAYBACK' ? 'Paused' : 'Stopped');
    const title = track.title || 'No track';
    const subtitle = track.artist || track.album || 'Tap play to start music';
    const room = escapeHtml(group.coordinatorName);
    const stateToneClass = isPlaying
      ? 'bg-emerald-100 text-emerald-700'
      : (displayState === 'Paused' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600');
    const mainVolume = group.members.length === 1
      ? (group.members[0]?.volume ?? 0)
      : (group.groupState?.volume ?? 0);

    return `
      <article class="sonos-now-card">
        <div class="sonos-now-card__header">
          <div>
            <h3 class="sonos-now-card__room">${room}</h3>
            <span class="sonos-now-card__status sonos-now-card__status--${displayState.toLowerCase()}">${displayState}${group.members.length > 1 ? ` · ${group.members.length} grouped` : ''}</span>
          </div>
          <span class="sonos-now-card__volume-badge">${mainVolume}%</span>
        </div>
        <div class="sonos-now-card__track">
          <p class="sonos-now-card__title">${escapeHtml(title)}</p>
          <p class="sonos-now-card__artist">${escapeHtml(subtitle)}</p>
        </div>
        <div class="sonos-now-card__controls">
          <button type="button" class="sonos-now-card__btn" data-action="uxPrevious" data-room="${room}">${PREV_SVG}</button>
          <button type="button" class="sonos-now-card__btn sonos-now-card__btn--play" data-action="uxPlayPause" data-room="${room}">${isPlaying ? PAUSE_SVG : PLAY_SVG}</button>
          <button type="button" class="sonos-now-card__btn" data-action="uxNext" data-room="${room}">${NEXT_SVG}</button>
        </div>
        <div class="sonos-now-card__slider">
          <span class="sonos-now-card__slider-label">${VOL_SVG}</span>
          <input type="range" min="0" max="100" value="${mainVolume}" data-action="uxVolume" data-room="${room}">
        </div>
      </article>
    `;
  }).join('');

  panel.innerHTML = `<div class="sonos-now-grid">${cards}</div>`;
}

function renderAmbientPanel() {
  const panel = document.getElementById('uxAmbientPanel');
  if (!panel) return;

  const ambientPlaylists = getAmbientPlaylists();
  const rooms = getTargetRooms();
  const currentRoom = document.getElementById('uxAmbientTarget')?.value || '';
  const currentPlaylist = document.getElementById('uxAmbientSource')?.value || '';
  const noAccessNote = deviceScope && !deviceScope.fullAccess
    ? '<p class="mb-3 rounded-aap border border-aap-border bg-white p-2 text-xs text-aap-text-muted">You only see and control zones you are allowed to access.</p>'
    : '';

  const roomOptions = rooms.length
    ? rooms.map(room => `<option value="${escapeHtml(room)}" ${currentRoom === room ? 'selected' : ''}>${escapeHtml(room)}</option>`).join('')
    : '<option value="">No zones</option>';

  const playlistOptions = ambientPlaylists.length
    ? ambientPlaylists.map(name => `<option value="${escapeHtml(name)}" ${currentPlaylist === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')
    : '<option value="">No ambient playlists found</option>';

  const chips = ambientPlaylists.slice(0, 8).map(name => (
    `<button type="button" class="rounded-full border border-aap-border bg-white px-3 py-1 text-xs text-aap-text-muted hover:bg-aap-cream" data-ambient-playlist="${escapeHtml(name)}">${escapeHtml(name)}</button>`
  )).join('');

  panel.innerHTML = `
    ${noAccessNote}
    <div class="grid gap-3 rounded-aap-lg border border-white/30 bg-white/95 p-4 shadow-aap-sm md:grid-cols-2">
      <label class="text-sm font-medium text-aap-text-muted">
        Target zone
        <select id="uxAmbientTarget" class="mt-1.5 w-full rounded-aap border border-aap-border bg-aap-cream px-2.5 py-2 text-sm text-aap-dark">${roomOptions}</select>
      </label>
      <label class="text-sm font-medium text-aap-text-muted">
        Ambient source
        <select id="uxAmbientSource" class="mt-1.5 w-full rounded-aap border border-aap-border bg-aap-cream px-2.5 py-2 text-sm text-aap-dark">${playlistOptions}</select>
      </label>
      <div class="flex flex-wrap items-center gap-2 md:col-span-2">
        <button type="button" id="uxAmbientStartBtn" class="rounded-full bg-aap-dark px-4 py-2 text-sm font-semibold text-white hover:opacity-90">Start Ambient</button>
        <button type="button" id="uxAmbientShuffleBtn" class="rounded-full border border-aap-border bg-white px-4 py-2 text-sm font-medium text-aap-text-muted hover:bg-aap-cream">Shuffle Ambient</button>
        <button type="button" id="uxAmbientPauseAllBtn" class="rounded-full border border-aap-border bg-white px-4 py-2 text-sm font-medium text-aap-text-muted hover:bg-aap-cream">Pause All</button>
      </div>
    </div>
    ${chips ? `<div class="mt-3 flex flex-wrap gap-2">${chips}</div>` : '<p class="mt-3 text-xs text-aap-cream/85">Create playlists with "ambient" in the name to enable quick rotation controls.</p>'}
  `;
}

async function startAmbientPlayback({ shuffle = false, forcedPlaylist = null } = {}) {
  const room = getSelectedAmbientTargetRoom();
  if (!room) {
    showToast('No target zone selected', 'error');
    return;
  }

  const ambientPlaylists = getAmbientPlaylists();
  const sourceSelect = document.getElementById('uxAmbientSource');
  let playlistName = forcedPlaylist || sourceSelect?.value || '';
  if (shuffle) {
    if (!ambientPlaylists.length) {
      showToast('No ambient playlists available', 'warning');
      return;
    }
    playlistName = ambientPlaylists[Math.floor(Math.random() * ambientPlaylists.length)];
    if (sourceSelect) sourceSelect.value = playlistName;
  }

  if (!playlistName) {
    showToast('Select an ambient playlist', 'error');
    return;
  }

  try {
    await sonosApi('playlist', { room, name: playlistName });
    showToast(`${shuffle ? 'Shuffled' : 'Started'} ambient on ${room}`, 'success', 2200);
    setTimeout(() => refreshAllZones(), 1500);
  } catch (err) {
    showToast(`Ambient playback failed: ${err.message}`, 'error');
  }
}

// =============================================
// SVG ICONS
// =============================================
const MUSIC_NOTE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
const PREV_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
const NEXT_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>';
const VOL_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
const MUTE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
const PLAYLIST_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>';
const STAR_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
const STAR_OUTLINE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/></svg>';
const LINK_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>';
const UNLINK_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17 7h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1 0 1.43-.98 2.63-2.31 2.98l1.46 1.46C20.88 15.61 22 13.95 22 12c0-2.76-2.24-5-5-5zm-1 4h-2.19l2 2H16v-2zM2 4.27l3.11 3.11C3.29 8.12 2 9.91 2 12c0 2.76 2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1 0-1.59 1.21-2.9 2.76-3.07L8.73 11H8v2h2.73L13 15.27V17h1.73l4.01 4.01 1.27-1.27L3.27 3 2 4.27z"/></svg>';
const ALARM_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M22 5.72l-4.6-3.86-1.29 1.53 4.6 3.86L22 5.72zM7.88 3.39L6.6 1.86 2 5.71l1.29 1.53 4.59-3.85zM12.5 8H11v6l4.75 2.85.75-1.23-4-2.37V8zM12 4c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9zm0 16c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>';
const LEAF_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6.05 8.05c-2.73 2.73-2.73 7.15-.02 9.88a6.985 6.985 0 004.95 2.05c.41 0 .82-.04 1.21-.12-1.44-.44-2.79-1.18-3.95-2.34-2.55-2.55-2.95-6.36-1.2-9.31l.01-.01c.38.23.8.35 1.24.35C9.8 8.55 11 7.35 11 5.84V2.02S4.47 3.66 6.05 8.05z"/><path d="M17.95 8.05c-1.58-4.39-8.11-6.03-8.11-6.03V5.84c0 1.52 1.2 2.72 2.72 2.72.43 0 .84-.12 1.21-.34 1.76 2.96 1.36 6.77-1.2 9.13-1.15 1.15-2.49 1.89-3.92 2.33.39.08.79.12 1.2.12 1.84 0 3.58-.72 4.89-2.03 2.71-2.73 2.71-7.15-.01-9.88l.01.01.02.01-.01.01c.38.23.8.36 1.24.36a2.72 2.72 0 002.72-2.72V2.02s-1.65.82-2.76 2.21"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>';
const EQ_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z"/></svg>';

// =============================================
// RENDERING - ZONE GROUPS
// =============================================
function renderZones() {
  const container = document.getElementById('sonosZones');
  if (!container) return;

  // Keep Spotify zone dropdown in sync
  populateSpotifyZones();

  // Update grouping mode button visibility
  const groupBtn = document.getElementById('groupRoomsBtn');
  if (groupBtn) {
    groupBtn.textContent = groupingMode ? 'Cancel Grouping' : 'Group Rooms';
    groupBtn.className = groupingMode ? 'btn-all-off' : 'btn-small';
  }

  if (!zoneGroups.length) {
    container.innerHTML = '<p class="text-muted" style="padding:2rem;text-align:center">No Sonos zones found. Is the Sonos system online?</p>';
    renderNowAmbient();
    return;
  }

  // Grouping mode controls bar
  const groupControls = groupingMode
    ? `<div class="sonos-group-controls">
        <span class="sonos-group-controls__hint">Select rooms to group together, then click "Group Selected"</span>
        <button class="btn-primary btn-small" id="groupSelectedBtn" disabled>Group Selected</button>
      </div>`
    : '';

  container.innerHTML = groupControls + zoneGroups.map(group => {
    const state = group.coordinatorState || {};
    const track = state.currentTrack || {};
    const isPlaying = state.playbackState === 'PLAYING';
    const isPaused = state.playbackState === 'PAUSED_PLAYBACK';
    const isLineIn = track.type === 'line_in';
    const isTVInput = track.title === 'TV' || track.type === 'tv';
    const hasTrack = track.title && track.title.trim() !== '';
    const trackTitle = isLineIn ? (track.stationName || 'Line-In Audio') : (track.title || '');
    const trackArtist = isLineIn ? 'External Source' : (track.artist || '');
    const artUrl = track.absoluteAlbumArtUri;
    const showArt = hasTrack && artUrl && !isLocalArtUrl(artUrl);
    const playMode = state.playMode || {};
    const duration = track.duration || 0;
    const coordName = escapeHtml(group.coordinatorName);
    const isGrouped = group.members.length > 1;

    // Group name: coordinator name + group indicator
    const memberNames = group.members
      .filter(m => !m.isCoordinator)
      .map(m => m.roomName);
    const groupTitle = isGrouped
      ? `${escapeHtml(group.coordinatorName)} <span class="sonos-group-badge">+${memberNames.length}</span>`
      : escapeHtml(group.coordinatorName);

    // Status line
    let statusText = 'Stopped';
    if (isPlaying) statusText = 'Playing';
    else if (isPaused) statusText = 'Paused';
    const modeIcons = [];
    if (playMode.shuffle) modeIcons.push('Shuffle');
    if (playMode.repeat === 'all') modeIcons.push('Repeat');
    else if (playMode.repeat === 'one') modeIcons.push('Repeat 1');

    // Ungroup button for grouped zones (rendered inline with group label)
    const ungroupBtn = isGrouped && isStaffPlus()
      ? `<button class="sonos-ungroup-btn" data-action="ungroup" data-room="${coordName}" title="Ungroup speakers">${UNLINK_SVG} Ungroup</button>`
      : '';

    // Grouping mode checkbox
    const groupCheckbox = groupingMode
      ? `<label class="sonos-group-checkbox">
          <input type="checkbox" data-group-room="${coordName}" ${groupingSelected.includes(group.coordinatorName) ? 'checked' : ''}>
        </label>`
      : '';

    // Grouped speakers: EQ section at top — room names with inline B/T sliders
    const fmtEq = (v) => (v > 0 ? '+' : '') + v;
    const groupEqSection = isGrouped
      ? `<div class="sonos-group-eq">
          <div class="sonos-group-eq__label-row">
            <div class="sonos-group-eq__label">${group.members.length} Speakers Grouped</div>
            ${ungroupBtn}
          </div>
          ${group.members.map(m => {
            const bal = balanceState[m.roomName] || 0;
            return `
            <div class="sonos-group-eq__room-summary">
              <span class="sonos-group-eq__name">${escapeHtml(m.roomName)}</span>
              <div class="sonos-balance-inline">
                <span class="sonos-balance-inline__label">L</span>
                <input type="range" min="-100" max="100" value="${bal}" class="sonos-balance-inline__slider"
                  data-action="balance" data-room="${escapeHtml(m.roomName)}">
                <span class="sonos-balance-inline__label">R</span>
              </div>
              <details class="sonos-group-eq__bt-details">
                <summary class="sonos-group-eq__bt-toggle">B/T ${CHEVRON_SVG}</summary>
                <div class="sonos-group-eq__sliders">
                  <div class="sonos-eq-inline">
                    <span class="sonos-eq-inline__label">B</span>
                    <input type="range" min="-10" max="10" value="${m.bass}" class="sonos-eq-inline__slider"
                      data-action="memberBass" data-room="${escapeHtml(m.roomName)}">
                    <span class="sonos-eq-inline__val" data-eq-bass-val="${escapeHtml(m.roomName)}">${fmtEq(m.bass)}</span>
                  </div>
                  <div class="sonos-eq-inline">
                    <span class="sonos-eq-inline__label">T</span>
                    <input type="range" min="-10" max="10" value="${m.treble}" class="sonos-eq-inline__slider"
                      data-action="memberTreble" data-room="${escapeHtml(m.roomName)}">
                    <span class="sonos-eq-inline__val" data-eq-treble-val="${escapeHtml(m.roomName)}">${fmtEq(m.treble)}</span>
                  </div>
                </div>
              </details>
            </div>`;
          }).join('')}
        </div>`
      : '';

    const memberVolumes = isGrouped
      ? `<div class="sonos-member-volumes">
          <button class="sonos-member-volumes__toggle" data-action="toggleMemberVols" type="button">
            Individual Volumes ${CHEVRON_SVG}
          </button>
          <div class="sonos-member-volumes__list hidden">
            ${group.members.map(m => `
              <div class="sonos-member-vol-row">
                <span class="sonos-member-vol-row__name">${escapeHtml(m.roomName)}</span>
                <input type="range" min="0" max="100" value="${m.volume}" class="sonos-member-vol-row__slider"
                  data-action="memberVolume" data-room="${escapeHtml(m.roomName)}">
                <span class="sonos-member-vol-row__val">${m.volume}%</span>
              </div>
            `).join('')}
          </div>
        </div>`
      : '';

    // Single speaker volume
    const mainVolume = group.members.length === 1
      ? group.members[0].volume
      : group.groupState?.volume ?? 0;
    const mainMuted = group.members.length === 1
      ? group.members[0].mute
      : group.groupState?.mute ?? false;

    const cardClasses = [
      'sonos-zone-card',
      isPlaying ? 'playing' : '',
      mainMuted ? 'muted' : '',
      isGrouped ? 'grouped' : '',
      groupingMode ? 'group-selectable' : '',
      groupingSelected.includes(group.coordinatorName) ? 'group-selected' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${cardClasses}" data-room="${coordName}" data-drop-target="true">
        ${groupCheckbox}

        ${groupEqSection}

        <div class="sonos-zone-card__header">
          <div class="sonos-zone-card__title">
            ${!isGrouped ? `<span class="sonos-zone-card__name">${groupTitle}</span>` : ''}
            <span class="sonos-zone-card__status">
              ${statusText}${modeIcons.length ? ' &middot; ' + modeIcons.join(', ') : ''}${duration > 0 ? ' &middot; ' + state.elapsedTimeFormatted + ' / ' + formatDuration(duration) : ''}
            </span>
          </div>
          ${!isGrouped ? `<div class="sonos-balance-inline sonos-balance-inline--header">
            <span class="sonos-balance-inline__label">L</span>
            <input type="range" min="-100" max="100" value="${balanceState[group.coordinatorName] || 0}" class="sonos-balance-inline__slider"
              data-action="balance" data-room="${coordName}">
            <span class="sonos-balance-inline__label">R</span>
          </div>` : ''}
        </div>

        <div class="sonos-zone-card__track">
          ${showArt
            ? `<img class="sonos-album-art" src="${escapeHtml(artUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : ''
          }
          <div class="sonos-album-art sonos-album-art--empty" ${showArt ? 'style="display:none"' : ''}>
            ${MUSIC_NOTE_SVG}
          </div>
          <div class="sonos-track-info">
            <span class="sonos-track-title">${hasTrack ? escapeHtml(trackTitle) : 'No track'}</span>
            <span class="sonos-track-artist">${escapeHtml(trackArtist)}</span>
          </div>
        </div>

        <div class="sonos-zone-card__controls">
          <button class="sonos-btn" data-action="previous" data-room="${coordName}" title="Previous">${PREV_SVG}</button>
          <button class="sonos-btn sonos-btn--play" data-action="playpause" data-room="${coordName}" title="${isPlaying ? 'Pause' : 'Play'}">
            ${isPlaying ? PAUSE_SVG : PLAY_SVG}
          </button>
          <button class="sonos-btn" data-action="next" data-room="${coordName}" title="Next">${NEXT_SVG}</button>
          <button class="sonos-btn sonos-btn--mute ${mainMuted ? 'active' : ''}" data-action="toggleMute" data-room="${coordName}" data-muted="${mainMuted ? '1' : '0'}" title="${mainMuted ? 'Unmute' : 'Mute'}">
            ${mainMuted ? MUTE_SVG : VOL_SVG}
          </button>
          ${!isGrouped ? `<button class="sonos-btn sonos-btn--eq" data-action="openEq" data-room="${coordName}" title="Equalizer">${EQ_SVG}</button>` : ''}
        </div>

        <div class="sonos-volume-control">
          <span class="sonos-volume-label">${mainVolume}%</span>
          <input type="range" min="0" max="100" value="${mainVolume}"
            data-action="volume" data-room="${coordName}">
        </div>

        ${memberVolumes}

        <div class="sonos-drop-hint hidden">Drop to play here</div>
      </div>
    `;
  }).join('');
  renderNowAmbient();
}

// =============================================
// RENDERING - MUSIC LIBRARY (Playlists + Favorites)
// =============================================
function renderMusicLibrary() {
  const libraryBody = document.getElementById('libraryBody');
  if (!libraryBody) return;

  const starredPlaylists = playlists.filter(name => isPlaylistStarred(name));
  const ambientPlaylists = playlists.filter(name => /ambient/i.test(name));

  let html = '';

  // Starred section
  if (starredPlaylists.length > 0) {
    html += renderLibrarySectionHtml('Starred', 'starredList', starredPlaylists, 'playlist', STAR_SVG, true);
  }

  // Ambient section
  if (ambientPlaylists.length > 0) {
    html += renderLibrarySectionHtml('Ambient', 'ambientList', ambientPlaylists, 'playlist', LEAF_SVG, true);
  }

  // All Playlists
  html += renderLibrarySectionHtml(`Playlists (${playlists.length})`, 'playlistsList', playlists, 'playlist', PLAYLIST_SVG, false, true);

  // Sonos Favorites
  html += renderLibrarySectionHtml(`Favorites (${favorites.length})`, 'favoritesList', favorites, 'favorite', STAR_SVG, false);

  libraryBody.innerHTML = html;
  renderNowAmbient();
}

function renderLibrarySectionHtml(label, listId, items, type, iconSvg, defaultOpen = true, showStars = false) {
  let itemsHtml = '';
  if (!items.length) {
    itemsHtml = `<p class="text-muted" style="font-size:0.8rem;padding:0.5rem 0;">None found.</p>`;
  } else {
    itemsHtml = items.map(name => {
      const starred = isPlaylistStarred(name);
      const starBtn = showStars && isStaffPlus()
        ? `<button class="sonos-library-item__star ${starred ? 'starred' : ''}" data-star-playlist="${escapeHtml(name)}" title="${starred ? 'Remove from starred' : 'Add to starred'}">${starred ? STAR_SVG : STAR_OUTLINE_SVG}</button>`
        : (showStars && starred ? `<span class="sonos-library-item__star starred">${STAR_SVG}</span>` : '');
      return `
        <div class="sonos-library-item" draggable="true" data-type="${type}" data-name="${escapeHtml(name)}">
          <span class="sonos-library-item__icon">${iconSvg}</span>
          <span class="sonos-library-item__name">${escapeHtml(name)}</span>
          ${starBtn}
        </div>
      `;
    }).join('');
  }

  return `
    <div class="sonos-library__section">
      <details ${defaultOpen ? 'open' : ''}>
        <summary class="sonos-library__section-header">
          <span>${label}</span>
          <span class="sonos-library__chevron">${CHEVRON_SVG}</span>
        </summary>
        <div id="${listId}" class="sonos-library__list">
          ${itemsHtml}
        </div>
      </details>
    </div>
  `;
}

// =============================================
// PLAYLIST STARRING
// =============================================
async function togglePlaylistStar(playlistName) {
  if (!isStaffPlus()) return;

  const existing = playlistTags.find(t => t.playlist_name === playlistName && t.tag === 'favorite');
  if (existing) {
    await supabase.from('sonos_playlist_tags').delete()
      .eq('playlist_name', playlistName).eq('tag', 'favorite');
    playlistTags = playlistTags.filter(t => !(t.playlist_name === playlistName && t.tag === 'favorite'));
    showToast(`Removed "${playlistName}" from starred`, 'info', 1500);
  } else {
    const { error } = await supabase.from('sonos_playlist_tags').insert({ playlist_name: playlistName, tag: 'favorite' });
    if (!error) {
      playlistTags.push({ playlist_name: playlistName, tag: 'favorite' });
      showToast(`Starred "${playlistName}"`, 'success', 1500);
    }
  }
  renderMusicLibrary();
}

// =============================================
// RENDERING - SCHEDULES
// =============================================
function renderSchedules() {
  const container = document.getElementById('schedulesList');
  if (!container) return;

  if (!schedules.length) {
    container.innerHTML = '<p class="text-muted" style="font-size:0.8rem;padding:0.75rem 0;text-align:center;">No scheduled alarms yet.</p>';
    renderNowAmbient();
    return;
  }

  container.innerHTML = schedules.map(s => {
    const timeStr = formatTime12h(s.time_of_day);
    const recStr = formatRecurrence(s);
    const activeClass = s.is_active ? '' : 'inactive';

    return `
      <div class="sonos-schedule-card ${activeClass}" data-schedule-id="${s.id}">
        <div class="sonos-schedule-card__left">
          <div class="sonos-schedule-card__time">${timeStr}</div>
          <div class="sonos-schedule-card__name">${escapeHtml(s.name)}</div>
        </div>
        <div class="sonos-schedule-card__meta">
          <span>${escapeHtml(s.room)}</span>
          <span>${escapeHtml(s.playlist_name)}</span>
          <span>${recStr}${s.volume != null ? ` &middot; Vol ${s.volume}%` : ''}${s.keep_grouped ? ' &middot; Grouped' : ''}</span>
        </div>
        <div class="sonos-schedule-card__actions">
          <label class="sonos-schedule-toggle" title="${s.is_active ? 'Active' : 'Inactive'}">
            <input type="checkbox" ${s.is_active ? 'checked' : ''} data-toggle-schedule="${s.id}">
            <span class="sonos-schedule-toggle__slider"></span>
          </label>
          ${isStaffPlus() ? `
            <button class="btn-small" data-edit-schedule="${s.id}">Edit</button>
            <button class="btn-small btn-danger-small" data-delete-schedule="${s.id}">Del</button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
  renderNowAmbient();
}

function formatTime12h(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function formatRecurrence(schedule) {
  switch (schedule.recurrence) {
    case 'daily': return 'Daily';
    case 'weekdays': return 'Weekdays';
    case 'weekends': return 'Weekends';
    case 'once': return schedule.one_time_date || 'Once';
    case 'custom': {
      const dayNames = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      return (schedule.custom_days || []).map(d => dayNames[d] || d).join(', ');
    }
    default: return schedule.recurrence;
  }
}

// =============================================
// SCHEDULE CRUD
// =============================================
function openScheduleModal(schedule = null) {
  // Remove existing modal if any
  document.getElementById('scheduleModal')?.remove();

  const isEdit = !!schedule;
  const rooms = getAllRoomNames();
  const allItems = [
    ...playlists.map(p => ({ name: p, type: 'playlist' })),
    ...favorites.map(f => ({ name: f, type: 'favorite' })),
  ];

  const modal = document.createElement('div');
  modal.id = 'scheduleModal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:420px;">
      <h3 style="margin:0 0 1rem;">${isEdit ? 'Edit' : 'New'} Schedule</h3>
      <form id="scheduleForm">
        <div class="form-group">
          <label>Name</label>
          <input type="text" name="name" required value="${escapeHtml(schedule?.name || '')}" placeholder="e.g. Morning Wake Up">
        </div>
        <div class="form-group">
          <label>Playlist / Favorite</label>
          <select name="playlist_name" required>
            <option value="">Select...</option>
            <optgroup label="Playlists">
              ${playlists.map(p => `<option value="${escapeHtml(p)}" data-source="playlist" ${schedule?.playlist_name === p && schedule?.source_type === 'playlist' ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
            </optgroup>
            <optgroup label="Favorites">
              ${favorites.map(f => `<option value="${escapeHtml(f)}" data-source="favorite" ${schedule?.playlist_name === f && schedule?.source_type === 'favorite' ? 'selected' : ''}>${escapeHtml(f)}</option>`).join('')}
            </optgroup>
          </select>
        </div>
        <div class="form-group">
          <label>Room</label>
          <select name="room" required>
            <option value="">Select...</option>
            ${rooms.map(r => `<option value="${escapeHtml(r)}" ${schedule?.room === r ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <label>Time</label>
            <input type="time" name="time_of_day" required value="${schedule?.time_of_day?.substring(0, 5) || '08:00'}">
          </div>
          <div class="form-group" style="flex:1">
            <label>Volume (optional)</label>
            <input type="number" name="volume" min="0" max="100" placeholder="—" value="${schedule?.volume ?? ''}">
          </div>
        </div>
        <div class="form-group">
          <label>Recurrence</label>
          <select name="recurrence" id="scheduleRecurrence">
            <option value="daily" ${schedule?.recurrence === 'daily' ? 'selected' : ''}>Daily</option>
            <option value="weekdays" ${schedule?.recurrence === 'weekdays' ? 'selected' : ''}>Weekdays</option>
            <option value="weekends" ${schedule?.recurrence === 'weekends' ? 'selected' : ''}>Weekends</option>
            <option value="custom" ${schedule?.recurrence === 'custom' ? 'selected' : ''}>Custom Days</option>
            <option value="once" ${schedule?.recurrence === 'once' ? 'selected' : ''}>One Time</option>
          </select>
        </div>
        <div class="form-group" id="customDaysGroup" style="display:${schedule?.recurrence === 'custom' ? 'block' : 'none'}">
          <label>Days</label>
          <div class="schedule-days">
            ${[['1','Mon'],['2','Tue'],['3','Wed'],['4','Thu'],['5','Fri'],['6','Sat'],['7','Sun']].map(([v,l]) =>
              `<label class="schedule-day-chip"><input type="checkbox" name="custom_days" value="${v}" ${(schedule?.custom_days || []).includes(parseInt(v)) ? 'checked' : ''}> ${l}</label>`
            ).join('')}
          </div>
        </div>
        <div class="form-group" id="oneDateGroup" style="display:${schedule?.recurrence === 'once' ? 'block' : 'none'}">
          <label>Date</label>
          <input type="date" name="one_time_date" value="${schedule?.one_time_date || ''}">
        </div>
        <label class="form-checkbox">
          <input type="checkbox" name="keep_grouped" ${schedule?.keep_grouped ? 'checked' : ''}>
          <span>Keep rooms grouped</span>
          <span class="form-checkbox__hint">When fired, also play on any rooms grouped with this room</span>
        </label>
        <div class="form-actions">
          <button type="button" class="btn-secondary" id="cancelScheduleBtn">Cancel</button>
          <button type="submit" class="btn-primary">${isEdit ? 'Save' : 'Create'}</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);

  // Toggle visibility of custom days / one-time date based on recurrence
  const recurrenceSelect = modal.querySelector('#scheduleRecurrence');
  recurrenceSelect.addEventListener('change', () => {
    modal.querySelector('#customDaysGroup').style.display = recurrenceSelect.value === 'custom' ? 'block' : 'none';
    modal.querySelector('#oneDateGroup').style.display = recurrenceSelect.value === 'once' ? 'block' : 'none';
  });

  // Cancel
  modal.querySelector('#cancelScheduleBtn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // Submit
  modal.querySelector('#scheduleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const playlistSelect = form.querySelector('[name="playlist_name"]');
    const selectedOption = playlistSelect.selectedOptions[0];

    const data = {
      name: form.name.value.trim(),
      playlist_name: playlistSelect.value,
      source_type: selectedOption?.dataset.source || 'playlist',
      room: form.room.value,
      time_of_day: form.time_of_day.value + ':00',
      volume: form.volume.value ? parseInt(form.volume.value) : null,
      recurrence: form.recurrence.value,
      custom_days: form.recurrence.value === 'custom'
        ? [...form.querySelectorAll('[name="custom_days"]:checked')].map(c => parseInt(c.value))
        : null,
      one_time_date: form.recurrence.value === 'once' ? form.one_time_date.value || null : null,
      keep_grouped: form.keep_grouped.checked,
    };

    try {
      if (isEdit) {
        data.updated_at = new Date().toISOString();
        const { error } = await supabase.from('sonos_schedules').update(data).eq('id', schedule.id);
        if (error) throw error;
        showToast('Schedule updated', 'success', 2000);
      } else {
        const { error } = await supabase.from('sonos_schedules').insert(data);
        if (error) throw error;
        showToast('Schedule created', 'success', 2000);
      }
      modal.remove();
      await loadSchedules();
      renderSchedules();
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    }
  });
}

async function toggleScheduleActive(id, isActive) {
  try {
    const { error } = await supabase.from('sonos_schedules')
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    await loadSchedules();
    renderSchedules();
    showToast(isActive ? 'Schedule activated' : 'Schedule paused', 'info', 1500);
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function deleteSchedule(id) {
  if (!confirm('Delete this schedule?')) return;
  try {
    const { error } = await supabase.from('sonos_schedules').delete().eq('id', id);
    if (error) throw error;
    await loadSchedules();
    renderSchedules();
    showToast('Schedule deleted', 'success', 1500);
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

// =============================================
// ROOM GROUPING
// =============================================
function toggleGroupingMode() {
  groupingMode = !groupingMode;
  groupingSelected = [];
  renderZones();
}

function updateGroupingSelection() {
  const btn = document.getElementById('groupSelectedBtn');
  if (btn) btn.disabled = groupingSelected.length < 2;
}

async function groupSelectedRooms() {
  if (groupingSelected.length < 2) return;
  const coordinator = groupingSelected[0];
  const members = groupingSelected.slice(1);

  try {
    for (const member of members) {
      await sonosApi('join', { room: member, other: coordinator });
    }
    showToast(`Grouped ${groupingSelected.length} rooms under ${coordinator}`, 'success');
    groupingMode = false;
    groupingSelected = [];
    setTimeout(() => refreshAllZones(), 2000);
  } catch (err) {
    showToast(`Grouping failed: ${err.message}`, 'error');
  }
}

async function ungroupZone(coordinatorName) {
  const group = zoneGroups.find(g => g.coordinatorName === coordinatorName);
  if (!group || group.members.length <= 1) return;

  try {
    const nonCoordinators = group.members.filter(m => !m.isCoordinator);
    for (const member of nonCoordinators) {
      await sonosApi('leave', { room: member.roomName });
    }
    showToast(`Ungrouped ${coordinatorName}`, 'success');
    setTimeout(() => refreshAllZones(), 2000);
  } catch (err) {
    showToast(`Ungrouping failed: ${err.message}`, 'error');
  }
}

// =============================================
// DRAG AND DROP
// =============================================
function setupDragAndDrop() {
  document.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.sonos-library-item') || e.target.closest('.sonos-search-result[draggable]');
    if (!item) return;
    if (item.dataset.type === 'spotify') {
      dragItem = { type: 'spotify', name: item.dataset.name, spotifyQuery: item.dataset.spotifyQuery, spotifySearchType: item.dataset.spotifySearchType };
    } else {
      dragItem = { type: item.dataset.type, name: item.dataset.name };
    }
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', item.dataset.name);
    document.querySelectorAll('.sonos-drop-hint').forEach(h => h.classList.remove('hidden'));
  });

  document.addEventListener('dragend', (e) => {
    const item = e.target.closest('.sonos-library-item') || e.target.closest('.sonos-search-result[draggable]');
    if (item) item.classList.remove('dragging');
    dragItem = null;
    document.querySelectorAll('.sonos-drop-hint').forEach(h => h.classList.add('hidden'));
    document.querySelectorAll('.sonos-zone-card').forEach(c => c.classList.remove('drag-over'));
  });

  const zonesContainer = document.getElementById('sonosZones');

  zonesContainer.addEventListener('dragover', (e) => {
    const card = e.target.closest('[data-drop-target]');
    if (!card) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    card.classList.add('drag-over');
  });

  zonesContainer.addEventListener('dragleave', (e) => {
    const card = e.target.closest('[data-drop-target]');
    if (!card) return;
    const related = e.relatedTarget;
    if (related && card.contains(related)) return;
    card.classList.remove('drag-over');
  });

  zonesContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    const card = e.target.closest('[data-drop-target]');
    if (!card || !dragItem) return;
    card.classList.remove('drag-over');
    document.querySelectorAll('.sonos-drop-hint').forEach(h => h.classList.add('hidden'));

    const room = card.dataset.room;
    const currentDragItem = dragItem;
    dragItem = null;

    card.classList.add('loading');
    try {
      if (currentDragItem.type === 'spotify') {
        await sonosApi('musicsearch', {
          room,
          service: 'spotify',
          searchType: currentDragItem.spotifySearchType || 'song',
          query: currentDragItem.spotifyQuery || currentDragItem.name
        });
      } else {
        await sonosApi(currentDragItem.type, { room, name: currentDragItem.name });
      }
      showToast(`Playing "${currentDragItem.name}" on ${room}`, 'success', 2500);
      setTimeout(() => refreshAllZones(), 2000);
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    } finally {
      card.classList.remove('loading');
    }
  });
}

// Mobile touch fallback: tap library item then tap zone
function setupTouchFallback() {
  document.addEventListener('click', (e) => {
    // Don't intercept star button clicks
    if (e.target.closest('[data-star-playlist]')) return;

    const item = e.target.closest('.sonos-library-item');
    if (!item) {
      if (pendingLibraryItem) cancelPendingItem();
      return;
    }

    if (pendingLibraryItem) cancelPendingItem();

    pendingLibraryItem = { type: item.dataset.type, name: item.dataset.name };
    item.classList.add('selected');
    document.querySelectorAll('.sonos-drop-hint').forEach(h => {
      h.textContent = `Tap to play "${item.dataset.name}"`;
      h.classList.remove('hidden');
    });
    document.querySelectorAll('.sonos-zone-card').forEach(c => c.classList.add('awaiting-drop'));
  });

  document.getElementById('sonosZones')?.addEventListener('click', async (e) => {
    if (!pendingLibraryItem) return;
    const card = e.target.closest('[data-drop-target]');
    if (!card) return;
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('label')) return;

    const room = card.dataset.room;
    const { type, name } = pendingLibraryItem;
    cancelPendingItem();

    card.classList.add('loading');
    try {
      await sonosApi(type, { room, name });
      showToast(`Playing "${name}" on ${room}`, 'success', 2500);
      setTimeout(() => refreshAllZones(), 2000);
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    } finally {
      card.classList.remove('loading');
    }
  });
}

function cancelPendingItem() {
  pendingLibraryItem = null;
  document.querySelectorAll('.sonos-library-item.selected').forEach(i => i.classList.remove('selected'));
  document.querySelectorAll('.sonos-drop-hint').forEach(h => h.classList.add('hidden'));
  document.querySelectorAll('.sonos-zone-card').forEach(c => c.classList.remove('awaiting-drop'));
}

// =============================================
// CONTROL FUNCTIONS
// =============================================
async function controlWithFeedback(roomName, action, params = {}) {
  const card = document.querySelector(`.sonos-zone-card[data-room="${CSS.escape(roomName)}"]`);
  card?.classList.add('loading');
  try {
    // Optimistic play/pause icon toggle
    if (action === 'playpause' && card) {
      const playBtn = card.querySelector('[data-action="playpause"]');
      const isCurrentlyPlaying = card.classList.contains('playing');
      if (playBtn) {
        playBtn.innerHTML = isCurrentlyPlaying ? PLAY_SVG : PAUSE_SVG;
        playBtn.title = isCurrentlyPlaying ? 'Play' : 'Pause';
      }
      card.classList.toggle('playing');
    }
    await sonosApi(action, { room: roomName, ...params });
    setTimeout(() => refreshAllZones(), 1000);
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
    // Revert on error
    if (action === 'playpause') refreshAllZones();
  } finally {
    card?.classList.remove('loading');
  }
}

async function setVolume(roomName, value) {
  try {
    await sonosApi('volume', { room: roomName, value: parseInt(value) });
  } catch (err) {
    showToast(`Volume failed: ${err.message}`, 'error');
  }
}

async function pauseAll() {
  try {
    await sonosApi('pauseall');
    showToast('All zones paused', 'success', 2000);
    setTimeout(() => refreshAllZones(), 1500);
  } catch (err) {
    showToast(`Pause all failed: ${err.message}`, 'error');
  }
}

// =============================================
// POLLING
// =============================================
async function refreshAllZones() {
  try {
    await loadZones();
    renderZones();
    updatePollStatus();
    supabaseHealth.recordSuccess();
  } catch (err) {
    console.warn('Zone refresh failed:', err);
    supabaseHealth.recordFailure();
    throw err; // let PollManager circuit breaker track failures
  }
}

function updatePollStatus() {
  const el = document.getElementById('pollStatus');
  if (!el) return;
  el.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
}

function startPolling() {
  if (poll) poll.stop();
  poll = new PollManager(refreshAllZones, POLL_INTERVAL_MS);
  poll.start();
  startElapsedTimer();
}

function stopPolling() {
  if (poll) { poll.stop(); poll = null; }
  stopElapsedTimer();
}

// Locally increment elapsed time every 10s for playing zones (no API call)
function startElapsedTimer() {
  stopElapsedTimer();
  elapsedTimer = setInterval(() => tickElapsedTime(), 10000);
}

function stopElapsedTimer() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

function tickElapsedTime() {
  for (const group of zoneGroups) {
    const state = group.coordinatorState;
    if (!state || state.playbackState !== 'PLAYING') continue;
    // Increment elapsed time by 10 seconds
    if (state.elapsedTime != null) {
      state.elapsedTime += 10;
      state.elapsedTimeFormatted = formatDuration(state.elapsedTime);
    }
  }
  // Update just the status elements in the DOM without full re-render
  for (const group of zoneGroups) {
    const state = group.coordinatorState;
    if (!state || state.playbackState !== 'PLAYING') continue;
    const track = state.currentTrack || {};
    const duration = track.duration || 0;
    const coordName = CSS.escape(escapeHtml(group.coordinatorName));
    const card = document.querySelector(`.sonos-zone-card[data-room="${coordName}"]`);
    if (!card) continue;
    const statusEl = card.querySelector('.sonos-zone-card__status');
    if (!statusEl) continue;
    const playMode = state.playMode || {};
    const modeIcons = [];
    if (playMode.shuffle) modeIcons.push('Shuffle');
    if (playMode.repeat === 'all') modeIcons.push('Repeat');
    else if (playMode.repeat === 'one') modeIcons.push('Repeat 1');
    statusEl.innerHTML = `Playing${modeIcons.length ? ' &middot; ' + modeIcons.join(', ') : ''}${duration > 0 ? ' &middot; ' + state.elapsedTimeFormatted + ' / ' + formatDuration(duration) : ''}`;
  }
}

function handleVisibilityChange() {
  if (document.hidden) {
    stopElapsedTimer();
  } else {
    startElapsedTimer();
    if (poll) poll.refresh(); // immediate re-poll + reset interval
  }
}

// =============================================
// LIBRARY SEARCH FILTER
// =============================================
function setupSearch() {
  const input = document.getElementById('librarySearch');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    document.querySelectorAll('.sonos-library-item').forEach(item => {
      const name = item.dataset.name.toLowerCase();
      item.style.display = !q || name.includes(q) ? '' : 'none';
    });
    // Also show/hide section headers if all items are hidden
    document.querySelectorAll('.sonos-library__section').forEach(section => {
      const list = section.querySelector('.sonos-library__list');
      if (!list || list.classList.contains('hidden')) return;
      const visibleItems = list.querySelectorAll('.sonos-library-item:not([style*="display: none"])');
      section.style.display = q && visibleItems.length === 0 ? 'none' : '';
    });
  });
}

// =============================================
// SPOTIFY SEARCH
// =============================================
let spotifyResults = [];
let spotifySelected = new Set();

function setupSpotifySearch() {
  const form = document.getElementById('spotifySearchForm');
  if (!form) return;

  populateSpotifyZones();

  // Search form submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = document.getElementById('spotifyQuery')?.value?.trim();
    const searchType = document.getElementById('spotifyType')?.value || 'song';
    const statusEl = document.getElementById('spotifySearchStatus');
    const btn = document.getElementById('spotifySearchBtn');
    const resultsEl = document.getElementById('spotifyResults');
    const playBar = document.getElementById('spotifyPlayBar');

    if (!query) return;

    btn.disabled = true;
    statusEl.classList.remove('hidden');
    statusEl.className = 'sonos-search__status';
    statusEl.textContent = `Searching for ${searchType}s...`;
    resultsEl.classList.add('hidden');
    playBar.classList.add('hidden');
    spotifyResults = [];
    spotifySelected.clear();

    try {
      const data = await sonosApi('spotify-search', { query, searchType, limit: 10 });
      spotifyResults = data.results || [];
      if (spotifyResults.length === 0) {
        statusEl.className = 'sonos-search__status sonos-search__status--error';
        statusEl.textContent = 'No results found.';
      } else {
        statusEl.classList.add('hidden');
        renderSpotifyResults();
        resultsEl.classList.remove('hidden');
        playBar.classList.remove('hidden');
        updatePlayBtn();
      }
    } catch (err) {
      statusEl.className = 'sonos-search__status sonos-search__status--error';
      statusEl.textContent = `Search failed: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // Play button click
  document.getElementById('spotifyPlayBtn')?.addEventListener('click', async () => {
    const zone = document.getElementById('spotifyZone')?.value;
    if (!zone) { showToast('Select a zone to play on', 'error'); return; }

    const selected = spotifyResults.filter((_, i) => spotifySelected.has(i));
    if (selected.length === 0) { showToast('Select at least one result', 'error'); return; }

    const playBtn = document.getElementById('spotifyPlayBtn');
    const statusEl = document.getElementById('spotifySearchStatus');
    playBtn.disabled = true;
    playBtn.textContent = '...';

    try {
      // Play the first selected via URI, then queue the rest
      for (let i = 0; i < selected.length; i++) {
        const item = selected[i];
        if (item.uri) {
          // Play directly by Spotify URI (more reliable than musicsearch)
          await sonosApi('spotify-play', {
            room: zone,
            uri: item.uri,
            enqueue: i > 0
          });
        } else {
          // Fallback to musicsearch for items without URI
          const searchType = document.getElementById('spotifyType')?.value || 'song';
          await sonosApi('musicsearch', {
            room: zone,
            service: 'spotify',
            searchType,
            query: searchType === 'song' ? `${item.title} ${item.artist}` : item.title
          });
        }
        if (i === 0) {
          statusEl.classList.remove('hidden');
          statusEl.className = 'sonos-search__status sonos-search__status--success';
          statusEl.textContent = `▶ Playing "${item.title}" on ${zone}`;
        }
      }
      setTimeout(() => refreshAllZones(), 2500);
      setTimeout(() => { statusEl.classList.add('hidden'); }, 4000);
    } catch (err) {
      statusEl.classList.remove('hidden');
      statusEl.className = 'sonos-search__status sonos-search__status--error';
      statusEl.textContent = `Playback failed: ${err.message}`;
    } finally {
      playBtn.disabled = false;
      playBtn.textContent = '▶';
    }
  });

  // Results click delegation
  document.getElementById('spotifyResults')?.addEventListener('click', (e) => {
    const item = e.target.closest('.sonos-search-result');
    if (!item) return;
    const idx = parseInt(item.dataset.idx, 10);
    if (isNaN(idx)) return;
    if (spotifySelected.has(idx)) {
      spotifySelected.delete(idx);
      item.classList.remove('sonos-search-result--selected');
    } else {
      spotifySelected.add(idx);
      item.classList.add('sonos-search-result--selected');
    }
    updatePlayBtn();
  });
}

function renderSpotifyResults() {
  const container = document.getElementById('spotifyResults');
  if (!container) return;
  const searchType = document.getElementById('spotifyType')?.value || 'song';
  container.innerHTML = spotifyResults.map((r, i) => {
    const dragQuery = searchType === 'song' ? `${r.title} ${r.artist}` : r.title;
    return `
    <div class="sonos-search-result ${spotifySelected.has(i) ? 'sonos-search-result--selected' : ''}" data-idx="${i}"
         draggable="true" data-type="spotify" data-name="${escapeHtml(r.title)}"
         data-spotify-query="${escapeHtml(dragQuery)}" data-spotify-search-type="${searchType}">
      ${r.albumArt ? `<img class="sonos-search-result__art" src="${r.albumArt}" alt="" loading="lazy">` : '<div class="sonos-search-result__art sonos-search-result__art--empty"></div>'}
      <div class="sonos-search-result__info">
        <div class="sonos-search-result__title">${escapeHtml(r.title)}</div>
        <div class="sonos-search-result__meta">${escapeHtml(r.artist)}${r.duration ? ` · ${r.duration}` : ''}</div>
      </div>
    </div>
  `;}).join('');
}

function updatePlayBtn() {
  const btn = document.getElementById('spotifyPlayBtn');
  if (!btn) return;
  const count = spotifySelected.size;
  btn.disabled = count === 0;
  btn.textContent = count > 1 ? `▶ ${count}` : '▶';
}


function populateSpotifyZones() {
  const select = document.getElementById('spotifyZone');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Zone...</option>';
  for (const z of zoneGroups) {
    const opt = document.createElement('option');
    opt.value = z.coordinatorName;
    opt.textContent = z.coordinatorName;
    if (z.coordinatorName === current) opt.selected = true;
    select.appendChild(opt);
  }
}

// =============================================
// EVENT LISTENERS
// =============================================
function setupEventListeners() {
  const zonesContainer = document.getElementById('sonosZones');
  const uxContainer = document.getElementById('uxNowAmbient');

  // New Now/Ambient surface interactions
  uxContainer?.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-ux-tab]');
    if (tabBtn) {
      uxActiveTab = tabBtn.dataset.uxTab === 'ambient' ? 'ambient' : 'now';
      renderNowAmbient();
      return;
    }

    const ambientChip = e.target.closest('[data-ambient-playlist]');
    if (ambientChip) {
      startAmbientPlayback({ forcedPlaylist: ambientChip.dataset.ambientPlaylist });
      return;
    }

    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      const room = actionBtn.dataset.room;
      switch (actionBtn.dataset.action) {
        case 'uxPlayPause': controlWithFeedback(room, 'playpause'); break;
        case 'uxNext': controlWithFeedback(room, 'next'); break;
        case 'uxPrevious': controlWithFeedback(room, 'previous'); break;
      }
      return;
    }

    if (e.target.id === 'uxAmbientStartBtn') {
      startAmbientPlayback();
      return;
    }
    if (e.target.id === 'uxAmbientShuffleBtn') {
      startAmbientPlayback({ shuffle: true });
      return;
    }
    if (e.target.id === 'uxAmbientPauseAllBtn') {
      pauseAll();
    }
  });

  uxContainer?.addEventListener('input', (e) => {
    if (e.target.dataset.action === 'uxVolume') {
      const room = e.target.dataset.room;
      clearTimeout(volumeTimers[`ux_${room}`]);
      volumeTimers[`ux_${room}`] = setTimeout(() => setVolume(room, e.target.value), 300);
    }
  });

  // Transport controls + grouping checkbox + ungroup
  zonesContainer.addEventListener('click', (e) => {
    // Grouping mode checkbox
    const groupCheckbox = e.target.closest('[data-group-room]');
    if (groupCheckbox && groupingMode) {
      const room = groupCheckbox.dataset.groupRoom;
      if (groupCheckbox.checked) {
        if (!groupingSelected.includes(room)) groupingSelected.push(room);
      } else {
        groupingSelected = groupingSelected.filter(r => r !== room);
      }
      // Update visual state
      document.querySelectorAll('.sonos-zone-card').forEach(card => {
        card.classList.toggle('group-selected', groupingSelected.includes(card.dataset.room));
      });
      updateGroupingSelection();
      return;
    }

    // Group Selected button
    if (e.target.id === 'groupSelectedBtn') {
      groupSelectedRooms();
      return;
    }

    // Ungroup button
    const ungroupBtn = e.target.closest('[data-action="ungroup"]');
    if (ungroupBtn) {
      ungroupZone(ungroupBtn.dataset.room);
      return;
    }

    if (pendingLibraryItem) return; // Don't handle transport if pending drop
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, room } = btn.dataset;
    switch (action) {
      case 'playpause': controlWithFeedback(room, 'playpause'); break;
      case 'next': controlWithFeedback(room, 'next'); break;
      case 'previous': controlWithFeedback(room, 'previous'); break;
      case 'toggleMute': {
        const isMuted = btn.dataset.muted === '1';
        controlWithFeedback(room, isMuted ? 'unmute' : 'mute');
        break;
      }
      case 'openEq': {
        openEqModal(room);
        break;
      }
    }
  });

  // Volume sliders (main + member) and inline EQ sliders
  zonesContainer.addEventListener('input', (e) => {
    const action = e.target.dataset.action;
    const room = e.target.dataset.room;

    if (action === 'volume') {
      const label = e.target.closest('.sonos-volume-control')?.querySelector('.sonos-volume-label');
      if (label) label.textContent = `${e.target.value}%`;
      clearTimeout(volumeTimers[room]);
      volumeTimers[room] = setTimeout(() => setVolume(room, e.target.value), 400);
      return;
    }

    if (action === 'memberVolume') {
      const volLabel = e.target.closest('.sonos-member-vol-row')?.querySelector('.sonos-member-vol-row__val');
      if (volLabel) volLabel.textContent = `${e.target.value}%`;
      clearTimeout(volumeTimers[room]);
      volumeTimers[room] = setTimeout(() => setVolume(room, e.target.value), 400);
      return;
    }

    if (action === 'memberBass') {
      const v = parseInt(e.target.value);
      const valEl = e.target.closest('.sonos-eq-inline')?.querySelector('.sonos-eq-inline__val');
      if (valEl) valEl.textContent = (v > 0 ? '+' : '') + v;
      debouncedEq('bass', room, v);
      return;
    }

    if (action === 'memberTreble') {
      const v = parseInt(e.target.value);
      const valEl = e.target.closest('.sonos-eq-inline')?.querySelector('.sonos-eq-inline__val');
      if (valEl) valEl.textContent = (v > 0 ? '+' : '') + v;
      debouncedEq('treble', room, v);
      return;
    }

    if (action === 'balance') {
      const v = parseInt(e.target.value);
      balanceState[room] = v;
      saveBalanceState();
      debouncedBalance(room, v);
      return;
    }
  });

  // Toggle individual volumes dropdown + tone controls expander
  zonesContainer.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-action="toggleMemberVols"]');
    if (toggleBtn) {
      const list = toggleBtn.closest('.sonos-member-volumes')?.querySelector('.sonos-member-volumes__list');
      if (list) {
        list.classList.toggle('hidden');
        toggleBtn.classList.toggle('open');
      }
      return;
    }

  });

  // Pause All
  document.getElementById('pauseAllBtn')?.addEventListener('click', () => pauseAll());

  // Refresh
  document.getElementById('refreshZonesBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('refreshZonesBtn');
    btn.disabled = true;
    btn.textContent = 'Refreshing...';
    await refreshAllZones();
    btn.disabled = false;
    btn.textContent = 'Refresh';
    showToast('Zones refreshed', 'info', 1500);
  });

  // Group Rooms button
  document.getElementById('groupRoomsBtn')?.addEventListener('click', () => toggleGroupingMode());

  // Star playlist clicks (delegated on library body)
  document.getElementById('libraryBody')?.addEventListener('click', (e) => {
    const starBtn = e.target.closest('[data-star-playlist]');
    if (starBtn) {
      e.stopPropagation();
      togglePlaylistStar(starBtn.dataset.starPlaylist);
    }
  });

  // Schedule section events
  const schedulesSection = document.getElementById('schedulesSection');
  if (schedulesSection) {
    // Add schedule button
    document.getElementById('addScheduleBtn')?.addEventListener('click', () => openScheduleModal());

    // Delegated clicks for edit/delete/toggle
    schedulesSection.addEventListener('click', (e) => {
      const editBtn = e.target.closest('[data-edit-schedule]');
      if (editBtn) {
        const s = schedules.find(s => s.id === parseInt(editBtn.dataset.editSchedule));
        if (s) openScheduleModal(s);
        return;
      }
      const deleteBtn = e.target.closest('[data-delete-schedule]');
      if (deleteBtn) {
        deleteSchedule(parseInt(deleteBtn.dataset.deleteSchedule));
        return;
      }
    });

    // Toggle active/inactive
    schedulesSection.addEventListener('change', (e) => {
      const toggle = e.target.closest('[data-toggle-schedule]');
      if (toggle) {
        toggleScheduleActive(parseInt(toggle.dataset.toggleSchedule), toggle.checked);
      }
    });
  }

  // Scene section events
  const scenesSection = document.getElementById('scenesSection');
  if (scenesSection) {
    document.getElementById('addSceneBtn')?.addEventListener('click', () => openSceneModal());

    scenesSection.addEventListener('click', (e) => {
      const activateBtn = e.target.closest('[data-activate-scene]');
      if (activateBtn) {
        activateScene(parseInt(activateBtn.dataset.activateScene));
        return;
      }
      const editBtn = e.target.closest('[data-edit-scene]');
      if (editBtn) {
        const s = scenes.find(s => s.id === parseInt(editBtn.dataset.editScene));
        if (s) openSceneModal(s);
        return;
      }
      const deleteBtn = e.target.closest('[data-delete-scene]');
      if (deleteBtn) {
        deleteScene(parseInt(deleteBtn.dataset.deleteScene));
      }
    });
  }

  // Scene bar activation (above zones)
  document.querySelector('.sonos-main')?.addEventListener('click', (e) => {
    const sceneBtn = e.target.closest('[data-activate-scene]');
    if (sceneBtn) activateScene(parseInt(sceneBtn.dataset.activateScene));
  });

  // Visibility
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('beforeunload', stopPolling);

  // Drag and drop + mobile fallback
  setupDragAndDrop();
  setupTouchFallback();
  setupSearch();
}

// =============================================
// SCENES
// =============================================

function renderSceneBar() {
  let bar = document.getElementById('sceneBar');
  if (!bar) {
    const sectionBody = document.querySelector('#zonesSection .section-body');
    if (!sectionBody) return;
    bar = document.createElement('div');
    bar.id = 'sceneBar';
    bar.className = 'sonos-scene-bar';
    sectionBody.parentNode.insertBefore(bar, sectionBody);
  }

  if (!scenes.length) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = '';
  bar.innerHTML = scenes.map(scene => {
    const isActivating = activatingScene === scene.id;
    return `
      <button class="sonos-scene-btn ${isActivating ? 'activating' : ''}"
              data-activate-scene="${scene.id}"
              ${isActivating ? 'disabled' : ''}
              title="${escapeHtml(scene.description || scene.name)}">
        <span class="sonos-scene-btn__emoji">${scene.emoji || '🎵'}</span>
        <span class="sonos-scene-btn__name">${escapeHtml(scene.name)}</span>
        ${isActivating ? '<span class="sonos-scene-btn__spinner"></span>' : ''}
      </button>
    `;
  }).join('');
}

function renderScenesSection() {
  const container = document.getElementById('scenesList');
  if (!container) return;

  if (!scenes.length) {
    container.innerHTML = '<p class="text-muted" style="font-size:0.8rem;padding:0.75rem 0;text-align:center;">No sonic scenes yet.</p>';
    return;
  }

  container.innerHTML = scenes.map(s => {
    const roomCount = (s.sonos_scene_actions || []).length;
    return `
      <div class="sonos-scene-card" data-scene-id="${s.id}">
        <div class="sonos-scene-card__left">
          <span class="sonos-scene-card__emoji">${s.emoji || '🎵'}</span>
          <div class="sonos-scene-card__info">
            <span class="sonos-scene-card__name">${escapeHtml(s.name)}</span>
            <span class="sonos-scene-card__detail">${roomCount} room${roomCount !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div class="sonos-scene-card__actions">
          <button class="btn-small sonos-scene-play-btn" data-activate-scene="${s.id}" title="Activate">&#9654;</button>
          ${isStaffPlus() ? `
            <button class="btn-small" data-edit-scene="${s.id}">Edit</button>
            <button class="btn-small btn-danger-small" data-delete-scene="${s.id}">&times;</button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function openSceneModal(scene = null) {
  document.getElementById('sceneModal')?.remove();

  const isEdit = !!scene;
  const rooms = getAllRoomNames();
  const existingActions = scene?.sonos_scene_actions || [];

  const modal = document.createElement('div');
  modal.id = 'sceneModal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card scene-modal">
      <h3 style="margin:0 0 1rem;">${isEdit ? 'Edit' : 'New'} Scene</h3>
      <form id="sceneForm">
        <div class="form-row">
          <div class="form-group" style="flex:0 0 3.5rem">
            <label>Emoji</label>
            <input type="text" name="emoji" value="${escapeHtml(scene?.emoji || '🎵')}"
                   maxlength="4" style="text-align:center;font-size:1.2rem">
          </div>
          <div class="form-group" style="flex:1">
            <label>Name</label>
            <input type="text" name="name" required value="${escapeHtml(scene?.name || '')}" placeholder="e.g. Tour Mode">
          </div>
        </div>
        <div class="form-group">
          <label>Description (optional)</label>
          <input type="text" name="description" value="${escapeHtml(scene?.description || '')}" placeholder="Brief description">
        </div>

        <div class="scene-rooms-header">
          <label>Room Configurations</label>
          <button type="button" class="btn-small" id="addSceneRoomBtn">+ Add Room</button>
        </div>
        <div id="sceneRoomsList" class="scene-rooms-list"></div>

        <div class="form-actions">
          <button type="button" class="btn-secondary" id="cancelSceneBtn">Cancel</button>
          <button type="submit" class="btn-primary">${isEdit ? 'Save' : 'Create'}</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);

  const roomsList = modal.querySelector('#sceneRoomsList');

  // Pre-populate room rows for editing, or start with one empty row
  if (existingActions.length) {
    existingActions
      .sort((a, b) => a.display_order - b.display_order)
      .forEach(action => addSceneRoomRow(roomsList, rooms, action));
  } else {
    addSceneRoomRow(roomsList, rooms);
  }

  modal.querySelector('#addSceneRoomBtn').addEventListener('click', () => {
    addSceneRoomRow(roomsList, rooms);
  });

  modal.querySelector('#cancelSceneBtn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  modal.querySelector('#sceneForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveScene(e.target, scene?.id);
    modal.remove();
  });
}

function addSceneRoomRow(container, rooms, action = null) {
  const row = document.createElement('div');
  row.className = 'scene-room-row';
  row.innerHTML = `
    <div class="scene-room-row__main">
      <select name="scene_room" required class="scene-room-select">
        <option value="">Room...</option>
        ${rooms.map(r => `<option value="${escapeHtml(r)}" ${action?.room === r ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}
      </select>
      <select name="scene_playlist" required>
        <option value="">Playlist/Fav...</option>
        <optgroup label="Playlists">
          ${playlists.map(p => `<option value="${escapeHtml(p)}" data-source="playlist" ${action?.playlist_name === p && action?.source_type === 'playlist' ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
        </optgroup>
        <optgroup label="Favorites">
          ${favorites.map(f => `<option value="${escapeHtml(f)}" data-source="favorite" ${action?.playlist_name === f && action?.source_type === 'favorite' ? 'selected' : ''}>${escapeHtml(f)}</option>`).join('')}
        </optgroup>
      </select>
      <button type="button" class="scene-room-remove" title="Remove">&times;</button>
    </div>
    <div class="scene-room-row__options">
      <div class="scene-room-opt">
        <label>Vol</label>
        <input type="number" name="scene_volume" min="0" max="100" placeholder="—" value="${action?.volume ?? ''}">
      </div>
      <div class="scene-room-opt">
        <label>Bass</label>
        <input type="number" name="scene_bass" min="-10" max="10" placeholder="—" value="${action?.bass ?? ''}">
      </div>
      <div class="scene-room-opt">
        <label>Treble</label>
        <input type="number" name="scene_treble" min="-10" max="10" placeholder="—" value="${action?.treble ?? ''}">
      </div>
      <div class="scene-room-opt">
        <label>Group&nbsp;with</label>
        <select name="scene_group_coordinator" class="scene-group-select">
          <option value="">Independent</option>
        </select>
      </div>
    </div>
  `;

  container.appendChild(row);

  row.querySelector('.scene-room-remove').addEventListener('click', () => {
    row.remove();
    updateGroupCoordinatorOptions(container);
  });

  row.querySelector('.scene-room-select').addEventListener('change', () => {
    updateGroupCoordinatorOptions(container);
  });

  updateGroupCoordinatorOptions(container);

  // Set initial group coordinator after options are populated
  if (action?.group_coordinator) {
    setTimeout(() => { row.querySelector('.scene-group-select').value = action.group_coordinator; }, 0);
  }
}

function updateGroupCoordinatorOptions(container) {
  const rows = container.querySelectorAll('.scene-room-row');
  const selectedRooms = [];
  rows.forEach(row => {
    const roomVal = row.querySelector('.scene-room-select')?.value;
    if (roomVal) selectedRooms.push(roomVal);
  });

  rows.forEach(row => {
    const groupSelect = row.querySelector('.scene-group-select');
    const currentVal = groupSelect.value;
    const thisRoom = row.querySelector('.scene-room-select')?.value;
    groupSelect.innerHTML = '<option value="">Independent</option>' +
      selectedRooms
        .filter(r => r !== thisRoom)
        .map(r => `<option value="${escapeHtml(r)}" ${currentVal === r ? 'selected' : ''}>${escapeHtml(r)}</option>`)
        .join('');
  });
}

async function saveScene(form, existingId = null) {
  const sceneData = {
    name: form.name.value.trim(),
    emoji: form.emoji.value.trim() || '🎵',
    description: form.description.value.trim() || null,
  };

  const roomRows = form.querySelectorAll('.scene-room-row');
  const actions = [];
  let order = 0;
  roomRows.forEach(row => {
    const room = row.querySelector('[name="scene_room"]').value;
    const playlistSelect = row.querySelector('[name="scene_playlist"]');
    const selectedOption = playlistSelect.selectedOptions[0];
    if (!room || !playlistSelect.value) return;

    actions.push({
      room,
      source_type: selectedOption?.dataset.source || 'playlist',
      playlist_name: playlistSelect.value,
      volume: row.querySelector('[name="scene_volume"]').value ? parseInt(row.querySelector('[name="scene_volume"]').value) : null,
      bass: row.querySelector('[name="scene_bass"]').value !== '' ? parseInt(row.querySelector('[name="scene_bass"]').value) : null,
      treble: row.querySelector('[name="scene_treble"]').value !== '' ? parseInt(row.querySelector('[name="scene_treble"]').value) : null,
      group_coordinator: row.querySelector('[name="scene_group_coordinator"]').value || null,
      display_order: order++,
    });
  });

  if (!actions.length) {
    showToast('Add at least one room', 'warning');
    return;
  }

  try {
    if (existingId) {
      sceneData.updated_at = new Date().toISOString();
      const { error } = await supabase.from('sonos_scenes').update(sceneData).eq('id', existingId);
      if (error) throw error;
      await supabase.from('sonos_scene_actions').delete().eq('scene_id', existingId);
      const { error: actError } = await supabase.from('sonos_scene_actions')
        .insert(actions.map(a => ({ ...a, scene_id: existingId })));
      if (actError) throw actError;
      showToast('Scene updated', 'success', 2000);
    } else {
      const { data: newScene, error } = await supabase.from('sonos_scenes').insert(sceneData).select().single();
      if (error) throw error;
      const { error: actError } = await supabase.from('sonos_scene_actions')
        .insert(actions.map(a => ({ ...a, scene_id: newScene.id })));
      if (actError) throw actError;
      showToast('Scene created', 'success', 2000);
    }
    await loadScenes();
    renderScenesSection();
    renderSceneBar();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function deleteScene(id) {
  if (!confirm('Delete this scene?')) return;
  try {
    const { error } = await supabase.from('sonos_scenes').delete().eq('id', id);
    if (error) throw error;
    await loadScenes();
    renderScenesSection();
    renderSceneBar();
    showToast('Scene deleted', 'success', 1500);
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

function sceneDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function activateScene(sceneId) {
  const scene = scenes.find(s => s.id === sceneId);
  if (!scene || activatingScene) return;

  const actions = scene.sonos_scene_actions || [];
  if (!actions.length) { showToast('Scene has no rooms configured', 'warning'); return; }

  activatingScene = sceneId;
  renderSceneBar();
  renderScenesSection();

  try {
    // Phase 1: Ungroup all scene rooms
    showToast('Ungrouping rooms...', 'info', 2000);
    for (const a of actions) {
      try { await sonosApi('leave', { room: a.room }); } catch {}
    }

    // Phase 2: Set up groups
    const groupMembers = actions.filter(a => a.group_coordinator && a.group_coordinator !== a.room);
    if (groupMembers.length > 0) {
      await sceneDelay(1500);
      showToast('Grouping rooms...', 'info', 2000);
      for (const a of groupMembers) {
        try { await sonosApi('join', { room: a.room, other: a.group_coordinator }); }
        catch (err) { console.error(`Group failed: ${a.room} → ${a.group_coordinator}`, err); }
      }
    }

    // Phase 3: Set volumes
    const volumeActions = actions.filter(a => a.volume != null);
    if (volumeActions.length > 0) {
      await sceneDelay(1000);
      showToast('Setting volumes...', 'info', 2000);
      for (const a of volumeActions) {
        try { await sonosApi('volume', { room: a.room, value: a.volume }); } catch {}
      }
    }

    // Phase 4: Play playlists on coordinators/independent rooms only
    const playActions = actions.filter(a => !a.group_coordinator || a.group_coordinator === a.room);
    await sceneDelay(1000);
    showToast('Starting playback...', 'info', 2000);
    for (const a of playActions) {
      try { await sonosApi(a.source_type, { room: a.room, name: a.playlist_name }); }
      catch (err) { console.error(`Play failed on ${a.room}`, err); }
    }

    // Phase 5: Set EQ
    const eqActions = actions.filter(a => a.bass != null || a.treble != null);
    if (eqActions.length > 0) {
      await sceneDelay(500);
      showToast('Setting EQ...', 'info', 2000);
      for (const a of eqActions) {
        if (a.bass != null) { try { await sonosApi('bass', { room: a.room, value: a.bass }); } catch {} }
        if (a.treble != null) { try { await sonosApi('treble', { room: a.room, value: a.treble }); } catch {} }
      }
    }

    showToast(`${scene.emoji} ${scene.name} activated!`, 'success', 3000);
  } catch (err) {
    showToast(`Scene failed: ${err.message}`, 'error');
  } finally {
    activatingScene = null;
    renderSceneBar();
    renderScenesSection();
    setTimeout(() => refreshAllZones(), 3000);
  }
}

// =============================================
// EQUALIZER MODAL
// =============================================
let eqTimers = {};

async function openEqModal(roomName) {
  // Fetch current EQ state
  let eq = { bass: 0, treble: 0, loudness: false };
  try {
    const state = await sonosApi('getState', { room: roomName });
    if (state.equalizer) {
      eq = state.equalizer;
    }
  } catch (err) {
    console.error('Failed to get EQ state:', err);
  }

  // Build modal
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card eq-modal">
      <div class="eq-modal__header">
        <h3>${EQ_SVG} ${escapeHtml(roomName)}</h3>
        <button class="sonos-btn eq-modal__close" title="Close">&times;</button>
      </div>

      <div class="eq-slider-group">
        <div class="eq-slider-row">
          <label class="eq-slider__label">Bass</label>
          <span class="eq-slider__value" id="eqBassVal">${eq.bass > 0 ? '+' : ''}${eq.bass}</span>
          <input type="range" min="-10" max="10" value="${eq.bass}" class="eq-slider" id="eqBassSlider">
          <div class="eq-slider__range"><span>-10</span><span>0</span><span>+10</span></div>
        </div>

        <div class="eq-slider-row">
          <label class="eq-slider__label">Treble</label>
          <span class="eq-slider__value" id="eqTrebleVal">${eq.treble > 0 ? '+' : ''}${eq.treble}</span>
          <input type="range" min="-10" max="10" value="${eq.treble}" class="eq-slider" id="eqTrebleSlider">
          <div class="eq-slider__range"><span>-10</span><span>0</span><span>+10</span></div>
        </div>

        <div class="eq-slider-row">
          <label class="eq-slider__label">Balance</label>
          <div class="eq-balance__labels"><span>L</span><span>C</span><span>R</span></div>
          <input type="range" min="-100" max="100" value="${balanceState[roomName] || 0}" class="eq-slider" id="eqBalanceSlider">
          <div class="eq-slider__range"><span>-100</span><span>0</span><span>+100</span></div>
        </div>

        <div class="eq-loudness-row">
          <span class="eq-slider__label">Loudness</span>
          <label class="toggle-switch">
            <input type="checkbox" id="eqLoudnessToggle" ${eq.loudness ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <div class="eq-modal__footer">
        <button class="sonos-btn eq-reset-btn" id="eqResetBtn">Reset to Flat</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Close handlers
  const close = () => { overlay.remove(); clearAllEqTimers(); };
  overlay.querySelector('.eq-modal__close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Bass slider
  const bassSlider = overlay.querySelector('#eqBassSlider');
  const bassVal = overlay.querySelector('#eqBassVal');
  bassSlider.addEventListener('input', () => {
    const v = parseInt(bassSlider.value);
    bassVal.textContent = (v > 0 ? '+' : '') + v;
    debouncedEq('bass', roomName, v);
  });

  // Treble slider
  const trebleSlider = overlay.querySelector('#eqTrebleSlider');
  const trebleVal = overlay.querySelector('#eqTrebleVal');
  trebleSlider.addEventListener('input', () => {
    const v = parseInt(trebleSlider.value);
    trebleVal.textContent = (v > 0 ? '+' : '') + v;
    debouncedEq('treble', roomName, v);
  });

  // Balance slider
  const balanceSlider = overlay.querySelector('#eqBalanceSlider');
  balanceSlider.addEventListener('input', () => {
    const v = parseInt(balanceSlider.value);
    balanceState[roomName] = v;
    saveBalanceState();
    debouncedBalance(roomName, v);
    // Also sync the inline header slider if visible
    const headerSlider = document.querySelector(`.sonos-balance-inline--header [data-room="${CSS.escape(escapeHtml(roomName))}"]`);
    if (headerSlider) headerSlider.value = v;
  });

  // Loudness toggle
  const loudnessToggle = overlay.querySelector('#eqLoudnessToggle');
  loudnessToggle.addEventListener('change', async () => {
    try {
      await sonosApi('loudness', { room: roomName, value: loudnessToggle.checked ? 'on' : 'off' });
    } catch (err) {
      showToast('Loudness not supported on this speaker', 'error');
      loudnessToggle.checked = !loudnessToggle.checked;
    }
  });

  // Reset button
  overlay.querySelector('#eqResetBtn').addEventListener('click', async () => {
    bassSlider.value = 0;
    bassVal.textContent = '0';
    trebleSlider.value = 0;
    trebleVal.textContent = '0';
    balanceSlider.value = 0;
    balanceState[roomName] = 0;
    saveBalanceState();
    try {
      await Promise.all([
        sonosApi('bass', { room: roomName, value: 0 }),
        sonosApi('treble', { room: roomName, value: 0 }),
        sonosApi('balance', { room: roomName, value: 0 }),
      ]);
      showToast('EQ reset to flat', 'info', 1500);
    } catch (err) {
      showToast('Failed to reset EQ', 'error');
    }
  });
}

function debouncedEq(type, room, value) {
  const key = `${type}_${room}`;
  clearTimeout(eqTimers[key]);
  eqTimers[key] = setTimeout(async () => {
    try {
      await sonosApi(type, { room, value });
    } catch (err) {
      showToast(`Failed to set ${type}`, 'error');
    }
  }, 300);
}

function clearAllEqTimers() {
  Object.values(eqTimers).forEach(t => clearTimeout(t));
  eqTimers = {};
}

// =============================================
// BALANCE CONTROL
// =============================================
let balanceTimers = {};

function debouncedBalance(room, value) {
  clearTimeout(balanceTimers[room]);
  balanceTimers[room] = setTimeout(async () => {
    try {
      await sonosApi('balance', { room, value });
    } catch (err) {
      showToast(`Balance failed: ${err.message}`, 'error');
    }
  }, 400);
}

function saveBalanceState() {
  try {
    localStorage.setItem('sonos_balance', JSON.stringify(balanceState));
  } catch {}
}

function loadBalanceState() {
  try {
    const saved = localStorage.getItem('sonos_balance');
    if (saved) balanceState = JSON.parse(saved);
  } catch {}
}
