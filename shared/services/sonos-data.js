/**
 * Sonos Data Service
 * Loads zone groups, playlists, favorites, and sends control commands via edge function.
 * No DOM code — just data fetching, state management, and control functions.
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabase.js';

const SONOS_CONTROL_URL = `${SUPABASE_URL}/functions/v1/sonos-control`;

// =============================================
// API WRAPPER
// =============================================

export async function sonosApi(action, params = {}) {
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
  if (!token) throw new Error('No auth token');

  const response = await fetch(SONOS_CONTROL_URL, {
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

/**
 * Load zone groups from Sonos HTTP API.
 * Returns parsed zone groups sorted by playback state.
 * @returns {Promise<Array<{coordinatorName, coordinatorState, groupState, members[]}>>}
 */
export async function loadZones() {
  const result = await sonosApi('getZones');
  if (!Array.isArray(result)) return [];

  const zoneGroups = [];
  for (const group of result) {
    const coord = group.coordinator;
    const members = group.members || [];
    zoneGroups.push({
      coordinatorName: coord.roomName,
      coordinatorState: coord.state,
      groupState: coord.groupState,
      members: members.map(m => ({
        roomName: m.roomName,
        volume: m.state?.volume ?? 0,
        mute: m.state?.mute ?? false,
        isCoordinator: m.roomName === coord.roomName,
        bass: m.state?.equalizer?.bass ?? 0,
        treble: m.state?.equalizer?.treble ?? 0,
      })),
    });
  }

  // Sort: playing first, then paused, then stopped
  const stateOrder = { PLAYING: 0, PAUSED_PLAYBACK: 1, TRANSITIONING: 2, STOPPED: 3 };
  zoneGroups.sort((a, b) => {
    const aOrder = stateOrder[a.coordinatorState?.playbackState] ?? 3;
    const bOrder = stateOrder[b.coordinatorState?.playbackState] ?? 3;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.coordinatorName.localeCompare(b.coordinatorName);
  });

  return zoneGroups;
}

/**
 * Load Sonos playlists from the first available zone.
 * @param {string} roomName - Room to query playlists from
 * @returns {Promise<Array<string>>}
 */
export async function loadPlaylists(roomName) {
  if (!roomName) return [];
  try {
    const result = await sonosApi('playlists', { room: roomName });
    return Array.isArray(result) ? result : [];
  } catch { return []; }
}

/**
 * Load Sonos favorites from the first available zone.
 * @param {string} roomName - Room to query favorites from
 * @returns {Promise<Array<string>>}
 */
export async function loadFavorites(roomName) {
  if (!roomName) return [];
  try {
    const result = await sonosApi('favorites', { room: roomName });
    return Array.isArray(result) ? result : [];
  } catch { return []; }
}

/**
 * Load starred playlist tags from DB.
 * @returns {Promise<Array<{playlist_name, tag}>>}
 */
export async function loadPlaylistTags() {
  try {
    const { data, error } = await supabase
      .from('sonos_playlist_tags')
      .select('playlist_name, tag');
    if (error) return [];
    return data || [];
  } catch { return []; }
}

/**
 * Load Sonos scenes from DB.
 * @returns {Promise<Array>}
 */
export async function loadScenes() {
  try {
    const { data, error } = await supabase
      .from('sonos_scenes')
      .select('*, sonos_scene_actions(*)')
      .eq('is_active', true)
      .order('display_order', { ascending: true });
    if (error) return [];
    return data || [];
  } catch { return []; }
}

// =============================================
// TRANSPORT CONTROLS
// =============================================

export async function playPause(roomName) {
  await sonosApi('playpause', { room: roomName });
}

export async function next(roomName) {
  await sonosApi('next', { room: roomName });
}

export async function previous(roomName) {
  await sonosApi('previous', { room: roomName });
}

export async function setVolume(roomName, value) {
  await sonosApi('volume', { room: roomName, value: parseInt(value) });
}

export async function mute(roomName) {
  await sonosApi('mute', { room: roomName });
}

export async function unmute(roomName) {
  await sonosApi('unmute', { room: roomName });
}

export async function pauseAll() {
  await sonosApi('pauseall');
}

/**
 * Play a playlist or favorite on a room.
 * @param {string} roomName
 * @param {'playlist'|'favorite'} type
 * @param {string} name - Playlist or favorite name
 */
export async function playItem(roomName, type, name) {
  await sonosApi(type, { room: roomName, name });
}

// =============================================
// SCENE ACTIVATION
// =============================================

/**
 * Activate a Sonos scene (multi-room coordinated playback).
 * Phases: ungroup → group → volume → play → EQ
 * @param {Object} scene - Scene with sonos_scene_actions array
 * @param {Function} [onProgress] - Optional callback for progress messages
 */
export async function activateScene(scene, onProgress) {
  const actions = scene.sonos_scene_actions || [];
  if (!actions.length) throw new Error('Scene has no rooms configured');

  const delay = ms => new Promise(r => setTimeout(r, ms));

  // Phase 1: Ungroup
  onProgress?.('Ungrouping rooms...');
  for (const a of actions) {
    try { await sonosApi('leave', { room: a.room }); } catch {}
  }

  // Phase 2: Group
  const groupMembers = actions.filter(a => a.group_coordinator && a.group_coordinator !== a.room);
  if (groupMembers.length > 0) {
    await delay(1500);
    onProgress?.('Grouping rooms...');
    for (const a of groupMembers) {
      try { await sonosApi('join', { room: a.room, other: a.group_coordinator }); } catch {}
    }
  }

  // Phase 3: Volumes
  const volActions = actions.filter(a => a.volume != null);
  if (volActions.length > 0) {
    await delay(1000);
    onProgress?.('Setting volumes...');
    for (const a of volActions) {
      try { await sonosApi('volume', { room: a.room, value: a.volume }); } catch {}
    }
  }

  // Phase 4: Play on coordinators/independent rooms
  const playActions = actions.filter(a => !a.group_coordinator || a.group_coordinator === a.room);
  await delay(1000);
  onProgress?.('Starting playback...');
  for (const a of playActions) {
    try { await sonosApi(a.source_type, { room: a.room, name: a.playlist_name }); } catch {}
  }

  // Phase 5: EQ
  const eqActions = actions.filter(a => a.bass != null || a.treble != null);
  if (eqActions.length > 0) {
    await delay(500);
    for (const a of eqActions) {
      if (a.bass != null) { try { await sonosApi('bass', { room: a.room, value: a.bass }); } catch {} }
      if (a.treble != null) { try { await sonosApi('treble', { room: a.room, value: a.treble }); } catch {} }
    }
  }
}

// =============================================
// HELPERS
// =============================================

export function isPlaylistStarred(playlistTags, name) {
  return playlistTags.some(t => t.playlist_name === name && t.tag === 'favorite');
}

export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Check if art URL is a local network address (not loadable from outside).
 */
export function isLocalArtUrl(url) {
  if (!url) return true;
  return /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost)/.test(url);
}
