/**
 * Music Tab - Mobile Sonos zone controls
 * Shows zone cards with play/pause, next/prev, volume slider.
 * Scenes bar at top for quick multi-room activation.
 * Starred playlists / favorites as quick-play chips.
 */

import {
  loadZones, loadPlaylists, loadFavorites, loadPlaylistTags, loadScenes,
  playPause, next, previous, setVolume, pauseAll, playItem, activateScene,
  isPlaylistStarred, formatDuration, isLocalArtUrl,
} from '../../../shared/services/sonos-data.js';
import { PollManager } from '../../../shared/services/poll-manager.js';

let zoneGroups = [];
let playlists = [];
let favorites = [];
let playlistTags = [];
let scenes = [];
let poller = null;
let activatingSceneId = null;

const volumeTimers = {};

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
const PREV_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
const NEXT_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>';
const MUSIC_NOTE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

// =============================================
// RENDERING
// =============================================
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function render() {
  const container = document.getElementById('musicContent');
  if (!container) return;

  let html = '';

  // Scenes bar
  if (scenes.length) {
    html += '<div class="m-scene-bar">';
    html += `<button class="m-scene-btn" data-action="pauseAll" style="border-color:var(--m-error);color:var(--m-error)">Pause All</button>`;
    for (const scene of scenes) {
      const isActivating = activatingSceneId === scene.id;
      html += `<button class="m-scene-btn ${isActivating ? 'activating' : ''}" data-action="scene" data-scene-id="${scene.id}">
        ${scene.icon || ''} ${esc(scene.name)}
      </button>`;
    }
    html += '</div>';
  }

  // Starred playlists / favorites
  const starred = playlists.filter(p => isPlaylistStarred(playlistTags, p));
  if (starred.length || favorites.length) {
    html += '<div class="m-fav-bar">';
    for (const name of starred) {
      html += `<button class="m-fav-chip" data-action="playPlaylist" data-name="${esc(name)}">&#9733; ${esc(name)}</button>`;
    }
    for (const name of favorites) {
      html += `<button class="m-fav-chip" data-action="playFavorite" data-name="${esc(name)}">&#9825; ${esc(name)}</button>`;
    }
    html += '</div>';
  }

  // Zone cards
  if (!zoneGroups.length) {
    html += '<div class="m-loading-inline">No Sonos zones found. Is the system online?</div>';
  } else {
    for (const group of zoneGroups) {
      html += renderZoneCard(group);
    }
  }

  container.innerHTML = html;
  bindEvents();
}

function renderZoneCard(group) {
  const state = group.coordinatorState || {};
  const track = state.currentTrack || {};
  const isPlaying = state.playbackState === 'PLAYING';
  const isLineIn = track.type === 'line_in';
  const hasTrack = track.title && track.title.trim() !== '';
  const trackTitle = isLineIn ? (track.stationName || 'Line-In Audio') : (track.title || '');
  const trackArtist = isLineIn ? 'External Source' : (track.artist || '');
  const artUrl = track.absoluteAlbumArtUri;
  const showArt = hasTrack && artUrl && !isLocalArtUrl(artUrl);

  const playingClass = isPlaying ? 'playing' : '';
  const statusText = isPlaying ? 'Playing' : state.playbackState === 'PAUSED_PLAYBACK' ? 'Paused' : 'Stopped';

  // Members
  const members = group.members || [];
  const memberCount = members.length;
  const groupLabel = memberCount > 1 ? ` +${memberCount - 1}` : '';

  // Volume (coordinator)
  const coordMember = members.find(m => m.isCoordinator) || members[0];
  const volume = coordMember?.volume ?? 0;

  return `
    <div class="m-zone-card ${playingClass}" data-room="${esc(group.coordinatorName)}">
      <div class="m-zone-card__header">
        <span class="m-zone-card__name">${esc(group.coordinatorName)}${groupLabel ? `<span style="font-weight:400;color:var(--m-text-muted);font-size:12px">${groupLabel}</span>` : ''}</span>
        <span class="m-zone-card__status">${statusText}</span>
      </div>

      ${hasTrack ? `
      <div class="m-zone-card__track">
        <div class="m-zone-card__art">
          ${showArt ? `<img src="${esc(artUrl)}" alt="" onerror="this.outerHTML='${MUSIC_NOTE}'">` : MUSIC_NOTE}
        </div>
        <div style="min-width:0;flex:1">
          <div class="m-track-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(trackTitle)}</div>
          ${trackArtist ? `<div class="m-track-artist" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(trackArtist)}</div>` : ''}
        </div>
      </div>` : ''}

      <div class="m-zone-controls">
        <button data-action="prev" data-room="${esc(group.coordinatorName)}">${PREV_SVG}</button>
        <button class="m-play-btn" data-action="playpause" data-room="${esc(group.coordinatorName)}">${isPlaying ? PAUSE_SVG : PLAY_SVG}</button>
        <button data-action="next" data-room="${esc(group.coordinatorName)}">${NEXT_SVG}</button>
      </div>

      <div class="m-volume-row">
        <span class="m-volume-row__label">${volume}</span>
        <input type="range" min="0" max="100" value="${volume}" class="m-slider"
               data-action="volume" data-room="${esc(group.coordinatorName)}">
      </div>
    </div>
  `;
}

// =============================================
// EVENTS
// =============================================
function bindEvents() {
  const container = document.getElementById('musicContent');
  if (!container) return;

  container.onclick = async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const room = btn.dataset.room;

    try {
      switch (action) {
        case 'playpause':
          await playPause(room);
          setTimeout(refreshZones, 500);
          break;
        case 'prev':
          await previous(room);
          setTimeout(refreshZones, 500);
          break;
        case 'next':
          await next(room);
          setTimeout(refreshZones, 500);
          break;
        case 'pauseAll':
          await pauseAll();
          toast('All zones paused', 'success', 2000);
          setTimeout(refreshZones, 500);
          break;
        case 'scene':
          await handleScene(parseInt(btn.dataset.sceneId));
          break;
        case 'playPlaylist':
          await handlePlayItem('playlist', btn.dataset.name);
          break;
        case 'playFavorite':
          await handlePlayItem('favorite', btn.dataset.name);
          break;
      }
    } catch (err) {
      toast(`Failed: ${err.message}`, 'error');
    }
  };

  // Volume sliders (debounced)
  container.querySelectorAll('[data-action="volume"]').forEach(input => {
    input.addEventListener('input', (e) => {
      const room = e.target.dataset.room;
      const value = parseInt(e.target.value);
      // Update label immediately
      const label = e.target.closest('.m-volume-row')?.querySelector('.m-volume-row__label');
      if (label) label.textContent = value;

      clearTimeout(volumeTimers[room]);
      volumeTimers[room] = setTimeout(async () => {
        try {
          await setVolume(room, value);
        } catch (err) {
          toast(`Volume failed: ${err.message}`, 'error');
        }
      }, 200);
    });
  });
}

async function handleScene(sceneId) {
  const scene = scenes.find(s => s.id === sceneId);
  if (!scene) return;

  activatingSceneId = sceneId;
  render();

  try {
    await activateScene(scene, (msg) => toast(msg, 'info', 2000));
    toast(`Scene "${scene.name}" activated`, 'success');
    setTimeout(refreshZones, 2000);
  } catch (err) {
    toast(`Scene failed: ${err.message}`, 'error');
  } finally {
    activatingSceneId = null;
    render();
  }
}

async function handlePlayItem(type, name) {
  // Pick first playing zone, or first zone
  const targetZone = zoneGroups.find(z => z.coordinatorState?.playbackState === 'PLAYING')
    || zoneGroups[0];
  if (!targetZone) {
    toast('No Sonos zone available', 'error');
    return;
  }

  try {
    await playItem(targetZone.coordinatorName, type, name);
    toast(`Playing ${name}`, 'success', 2000);
    setTimeout(refreshZones, 1000);
  } catch (err) {
    toast(`Failed to play: ${err.message}`, 'error');
  }
}

// =============================================
// POLLING
// =============================================
async function refreshZones() {
  try {
    zoneGroups = await loadZones();
    render();
  } catch (err) {
    console.warn('Sonos refresh failed:', err.message);
  }
}

// =============================================
// INIT
// =============================================
export async function init(user) {
  try {
    // Load zones first
    zoneGroups = await loadZones();
    render();

    // Load supplementary data in parallel
    const firstRoom = zoneGroups[0]?.coordinatorName;
    const [pl, fav, tags, sc] = await Promise.all([
      loadPlaylists(firstRoom),
      loadFavorites(firstRoom),
      loadPlaylistTags(),
      loadScenes(),
    ]);
    playlists = pl;
    favorites = fav;
    playlistTags = tags;
    scenes = sc;
    render();

    // Poll zones
    poller = new PollManager(() => refreshZones(), 30000);
    poller.start();
  } catch (err) {
    console.error('Music tab init failed:', err);
    const container = document.getElementById('musicContent');
    if (container) {
      container.innerHTML = '<div class="m-error">Failed to load Sonos zones.</div>';
    }
  }
}
