/**
 * Camera Data Service
 * Loads camera stream config from DB and provides HLS URL builder.
 * No DOM code — just data fetching and stream management.
 */

import { supabase } from '../supabase.js';

const PTZ_PROXY_BASE = 'https://YOUR_CAMERA_PROXY/ptz';
const CAMERA_PROXY_BASE = 'https://YOUR_CAMERA_PROXY/camera';

/**
 * Load cameras from camera_streams table, grouped by camera_name.
 * @returns {Promise<Array<{name, location, protectUrl, protectCameraId, streams}>>}
 */
export async function loadCameras() {
  const { data, error } = await supabase
    .from('camera_streams')
    .select('*')
    .eq('is_active', true)
    .order('camera_name')
    .order('quality');

  if (error) {
    console.error('Failed to load camera streams:', error);
    throw error;
  }

  const grouped = {};
  for (const stream of data) {
    if (!grouped[stream.camera_name]) {
      grouped[stream.camera_name] = {
        name: stream.camera_name,
        location: stream.location,
        model: stream.camera_model,
        protectUrl: stream.protect_share_url,
        protectCameraId: stream.protect_camera_id,
        streams: {},
      };
    }
    grouped[stream.camera_name].streams[stream.quality] = stream;
  }
  return Object.values(grouped).sort((a, b) =>
    (a.model || '').localeCompare(b.model || '') || a.name.localeCompare(b.name)
  );
}

/**
 * Build HLS URL for a given stream record.
 * @param {{proxy_base_url: string, stream_name: string}} stream
 * @returns {string}
 */
export function buildHlsUrl(stream) {
  return `${stream.proxy_base_url}/api/stream.m3u8?src=${stream.stream_name}&mp4`;
}

/**
 * Send a PTZ command (move, stop, home, goto preset).
 * @param {string} protectCameraId
 * @param {string} direction - up|down|left|right|zoomin|zoomout|stop|home|goto
 * @param {number} [slot] - preset slot for goto
 */
export async function sendPtzCommand(protectCameraId, direction, slot) {
  if (!protectCameraId) throw new Error('No camera ID for PTZ');

  const speed = 500;
  let payload;

  switch (direction) {
    case 'up':      payload = { action: 'move', x: 0, y: speed, z: 0 }; break;
    case 'down':    payload = { action: 'move', x: 0, y: -speed, z: 0 }; break;
    case 'left':    payload = { action: 'move', x: -speed, y: 0, z: 0 }; break;
    case 'right':   payload = { action: 'move', x: speed, y: 0, z: 0 }; break;
    case 'zoomin':  payload = { action: 'move', x: 0, y: 0, z: speed }; break;
    case 'zoomout': payload = { action: 'move', x: 0, y: 0, z: -speed }; break;
    case 'stop':    payload = { action: 'move', x: 0, y: 0, z: 0 }; break;
    case 'home':    payload = { action: 'goto', slot: -1 }; break;
    case 'goto':    payload = { action: 'goto', slot: slot ?? -1 }; break;
    default: return;
  }

  const resp = await fetch(`${PTZ_PROXY_BASE}/${protectCameraId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(err || `PTZ error ${resp.status}`);
  }
}

/**
 * Fetch camera settings (IR, LED, HDR) from proxy.
 * @param {string} protectCameraId
 * @returns {Promise<Object|null>}
 */
export async function fetchCameraSettings(protectCameraId) {
  if (!protectCameraId) return null;
  try {
    const resp = await fetch(`${CAMERA_PROXY_BASE}/${protectCameraId}/settings`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Update camera settings (IR mode, LED, HDR).
 * @param {string} protectCameraId
 * @param {Object} settings - e.g. { irLedMode: 'auto', statusLightEnabled: true }
 * @returns {Promise<boolean>}
 */
export async function updateCameraSettings(protectCameraId, settings) {
  if (!protectCameraId) return false;
  const resp = await fetch(`${CAMERA_PROXY_BASE}/${protectCameraId}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return resp.ok;
}

/**
 * Take a snapshot and return a blob URL.
 * @param {string} protectCameraId
 * @returns {Promise<string>} Object URL of the snapshot blob
 */
export async function takeSnapshot(protectCameraId) {
  if (!protectCameraId) throw new Error('No camera ID');
  const resp = await fetch(`${CAMERA_PROXY_BASE}/${protectCameraId}/snapshot`);
  if (!resp.ok) throw new Error('Snapshot failed');
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}
