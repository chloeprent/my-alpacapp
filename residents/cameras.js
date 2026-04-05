/**
 * Cameras Page - Live camera feeds via go2rtc WebRTC (HLS fallback)
 * Loads stream config from camera_streams table, plays via WebRTC or HLS.js
 * Features: quality selection, PTZ controls, snapshots, IR/LED/HDR toggles, presets, lightbox
 */

import { initResidentPage, showToast } from '../shared/resident-shell.js';
import { supabase } from '../shared/supabase.js';
import { getResidentDeviceScope } from '../shared/services/resident-device-scope.js';

let cameras = []; // grouped by camera_name
let currentQualities = {}; // track selected quality per cam index
let deviceScope = null;

// Camera settings cache (keyed by protectCameraId)
let cameraSettings = {};

// Blink snapshot refresh intervals
const blinkRefreshIntervals = {};
const BLINK_REFRESH_MS = 60000; // refresh snapshot every 60s
const BLINK_STORAGE_BASE = 'YOUR_SUPABASE_URL/storage/v1/object/public/housephotos';
const BLINK_SNAPSHOT_PATH = 'cameras/blink-latest.jpg';

const PTZ_PROXY_BASE = 'https://YOUR_CAMERA_PROXY/ptz';
const CAMERA_PROXY_BASE = 'https://YOUR_CAMERA_PROXY/camera';
const SENSORS_PROXY_BASE = 'https://YOUR_CAMERA_PROXY/sensors';
const EVENTS_PROXY_BASE = 'https://YOUR_CAMERA_PROXY/protect';


// =============================================
// INITIALIZATION
// =============================================
document.addEventListener('DOMContentLoaded', async () => {
  await initResidentPage({
    activeTab: 'devices',
    requiredRole: 'resident',
    onReady: async (authState) => {
      deviceScope = await getResidentDeviceScope(authState.appUser, authState.hasPermission);
      await loadCameras();
      renderCameras();
      renderLightbox();
      bindKeyboard();
      // Load settings for all cameras with PTZ support
      loadAllCameraSettings();
      // Load and display sensors
      await loadSensors();
      renderSensors();
      startSensorPolling();
      startLocalClock();
      // Load and display recent events
      initEventFilters();
      loadEvents();
    },
  });
});

// =============================================
// DATA
// =============================================
async function loadCameras() {
  const { data, error } = await supabase
    .from('camera_streams')
    .select('*')
    .eq('is_active', true)
    .order('camera_name')
    .order('quality');

  if (error) {
    console.error('Failed to load camera streams:', error);
    showToast('Failed to load cameras', 'error');
    return;
  }

  // Group by camera_name
  const grouped = {};
  for (const stream of data) {
    if (deviceScope && !deviceScope.fullAccess) {
      // Cameras without a space_id are common/security cameras — accessible to all residents
      const hasSpaceId = !!stream.space_id;
      const canAccess = !hasSpaceId
        || deviceScope.canAccessSpaceId(stream.space_id)
        || deviceScope.canAccessSpaceName(stream.location)
        || deviceScope.canAccessSpaceName(stream.camera_name);
      if (!canAccess) continue;
    }

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
  cameras = Object.values(grouped).sort((a, b) =>
    (a.model || '').localeCompare(b.model || '') || a.name.localeCompare(b.name)
  );
}

// =============================================
// CAMERA SETTINGS
// =============================================
async function loadAllCameraSettings() {
  for (const cam of cameras) {
    if (cam.protectCameraId) {
      fetchCameraSettings(cam);
    }
  }
}

async function fetchCameraSettings(cam) {
  if (!cam.protectCameraId) return null;
  try {
    const resp = await fetch(`${CAMERA_PROXY_BASE}/${cam.protectCameraId}/settings`);
    if (!resp.ok) return null;
    const data = await resp.json();
    cameraSettings[cam.protectCameraId] = data;
    updateToolbarState(cam);
    return data;
  } catch (err) {
    console.error('Failed to fetch camera settings:', err);
    return null;
  }
}

async function updateCameraSetting(cam, settings) {
  if (!cam.protectCameraId) return false;
  try {
    const resp = await fetch(`${CAMERA_PROXY_BASE}/${cam.protectCameraId}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    if (!resp.ok) {
      showToast('Failed to update setting', 'error');
      return false;
    }
    // Refresh settings
    await fetchCameraSettings(cam);
    return true;
  } catch (err) {
    showToast('Camera settings unavailable', 'error');
    return false;
  }
}

function updateToolbarState(cam) {
  const s = cameraSettings[cam.protectCameraId];
  if (!s) return;

  // Find the camera index
  const camIdx = cameras.indexOf(cam);

  // Update grid toolbar
  const gridIr = document.querySelector(`.ir-select[data-cam="${camIdx}"]`);
  if (gridIr) gridIr.value = s.irLedMode || 'auto';

  const gridLed = document.querySelector(`.led-toggle[data-cam="${camIdx}"]`);
  if (gridLed) gridLed.classList.toggle('active', !!s.statusLightEnabled);

  const gridHdr = document.querySelector(`.hdr-toggle[data-cam="${camIdx}"]`);
  if (gridHdr) gridHdr.classList.toggle('active', !!s.hdrModeEnabled);

  // Update lightbox toolbar if this camera is currently shown
  if (lightboxOpen && lightboxCamIndex === camIdx) {
    const lbIr = document.getElementById('lb-ir-mode');
    if (lbIr) lbIr.value = s.irLedMode || 'auto';

    const lbLed = document.getElementById('lb-led-toggle');
    if (lbLed) {
      lbLed.classList.toggle('active', !!s.statusLightEnabled);
      lbLed.textContent = s.statusLightEnabled ? 'On' : 'Off';
    }

    const lbHdr = document.getElementById('lb-hdr-toggle');
    if (lbHdr) {
      lbHdr.classList.toggle('active', !!s.hdrModeEnabled);
      lbHdr.textContent = s.hdrModeEnabled ? 'On' : 'Off';
    }
  }
}

// =============================================
// SNAPSHOT
// =============================================
async function takeSnapshot(cam) {
  if (!cam.protectCameraId) return;
  try {
    showToast('Capturing snapshot...', 'info');
    const resp = await fetch(`${CAMERA_PROXY_BASE}/${cam.protectCameraId}/snapshot`);
    if (!resp.ok) {
      showToast('Snapshot failed', 'error');
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${cam.name.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Snapshot saved', 'success');
  } catch (err) {
    showToast('Snapshot unavailable', 'error');
  }
}

// =============================================
// SVG ICONS
// =============================================
const ICONS = {
  snapshot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  ir: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
  led: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>',
  hdr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><text x="12" y="15" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">HDR</text></svg>',
};

// =============================================
// RENDER CAMERA GRID
// =============================================
function renderCameras() {
  const grid = document.getElementById('cameraGrid');
  if (!grid) return;

  if (!cameras.length) {
    grid.innerHTML = '<p style="color:var(--text-muted);padding:2rem;text-align:center">No cameras configured.</p>';
    return;
  }

  grid.innerHTML = cameras.map((cam, i) => {
    const isBlink = cam.model === 'Blink';

    if (isBlink) {
      // Blink camera: snapshot-only card (no HLS video)
      return `
    <div class="camera-card" data-cam-index="${i}">
      <div class="camera-card__label">
        <span class="status-dot status-live" id="dot-${i}" title="Cloud camera"></span>
        <span>${cam.name}</span>
        <div class="camera-card__controls">
          <span style="font-weight:400;color:var(--text-muted);font-size:0.7rem">${cam.location || ''} · Blink (snapshot)</span>
        </div>
      </div>
      <div class="camera-card__video blink-snapshot-container" id="video-container-${i}" data-cam="${i}">
        <img id="blink-img-${i}" class="blink-snapshot-img"
          src="${BLINK_STORAGE_BASE}/${BLINK_SNAPSHOT_PATH}?t=${Date.now()}"
          alt="${cam.name} snapshot"
          onerror="this.style.opacity='0.3'"
          onload="this.style.opacity='1'"
        />
        <div class="camera-card__overlay hidden" id="overlay-${i}">
          <div class="camera-card__loading">Loading snapshot...</div>
        </div>
        <div class="blink-snapshot-badge" id="blink-badge-${i}">
          <span class="blink-snapshot-time" id="blink-time-${i}">Refreshing...</span>
        </div>
        <!-- Expand button -->
        <button class="camera-card__expand" data-cam="${i}" title="Fullscreen">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="15 3 21 3 21 9"></polyline>
            <polyline points="9 21 3 21 3 15"></polyline>
            <line x1="21" y1="3" x2="14" y2="10"></line>
            <line x1="3" y1="21" x2="10" y2="14"></line>
          </svg>
        </button>
      </div>
    </div>`;
    }

    // Standard HLS camera card
    return `
    <div class="camera-card" data-cam-index="${i}">
      <div class="camera-card__label">
        <span class="status-dot" id="dot-${i}"></span>
        <span>${cam.name}</span>
        <div class="camera-card__controls">
          <span style="font-weight:700;color:var(--aap-accent, #3b82f6);font-size:0.7rem">${cam.model ? `${cam.model}` : ''}${cam.location ? ` – ${cam.location}` : ''}</span>
          <select class="quality-select" data-cam="${i}" style="margin-left:auto">
            ${cam.streams.low ? '<option value="low">Low</option>' : ''}
            ${cam.streams.med ? '<option value="med" selected>Med</option>' : ''}
            ${cam.streams.high ? '<option value="high">High</option>' : ''}
          </select>
        </div>
      </div>
      <div class="camera-card__video" id="video-container-${i}" data-cam="${i}">
        <video id="video-${i}" muted autoplay playsinline></video>
        <div class="camera-card__overlay" id="overlay-${i}">
          <div class="camera-card__loading">Connecting...</div>
        </div>
        <!-- Expand button -->
        <button class="camera-card__expand" data-cam="${i}" title="Fullscreen">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="15 3 21 3 21 9"></polyline>
            <polyline points="9 21 3 21 3 15"></polyline>
            <line x1="21" y1="3" x2="14" y2="10"></line>
            <line x1="3" y1="21" x2="10" y2="14"></line>
          </svg>
        </button>
        ${cam.protectCameraId ? `
        <!-- PTZ Controls (mobile overlay) -->
        <div class="ptz-controls ptz-controls--mobile" id="ptz-mobile-${i}">
          <button class="ptz-btn ptz-up" data-cam="${i}" data-dir="up" title="Tilt Up">▲</button>
          <button class="ptz-btn ptz-left" data-cam="${i}" data-dir="left" title="Pan Left">◀</button>
          <button class="ptz-btn ptz-home" data-cam="${i}" data-dir="home" title="Home Position">⌂</button>
          <button class="ptz-btn ptz-right" data-cam="${i}" data-dir="right" title="Pan Right">▶</button>
          <button class="ptz-btn ptz-down" data-cam="${i}" data-dir="down" title="Tilt Down">▼</button>
          <button class="ptz-btn ptz-zoomin" data-cam="${i}" data-dir="zoomin" title="Zoom In">+</button>
          <button class="ptz-btn ptz-zoomout" data-cam="${i}" data-dir="zoomout" title="Zoom Out">−</button>
        </div>
        ` : ''}
      </div>
      ${cam.protectCameraId ? `
      <!-- Controls bar below video (desktop) -->
      <div class="camera-card__controls-bar" data-cam="${i}">
        <div class="controls-bar__ptz" id="ptz-${i}">
          <button class="ptz-btn ptz-up" data-cam="${i}" data-dir="up" title="Tilt Up">▲</button>
          <button class="ptz-btn ptz-left" data-cam="${i}" data-dir="left" title="Pan Left">◀</button>
          <button class="ptz-btn ptz-home" data-cam="${i}" data-dir="home" title="Home Position">⌂</button>
          <button class="ptz-btn ptz-right" data-cam="${i}" data-dir="right" title="Pan Right">▶</button>
          <button class="ptz-btn ptz-down" data-cam="${i}" data-dir="down" title="Tilt Down">▼</button>
          <button class="ptz-btn ptz-zoomin" data-cam="${i}" data-dir="zoomin" title="Zoom In">+<span class="ptz-label">Zoom In</span></button>
          <button class="ptz-btn ptz-zoomout" data-cam="${i}" data-dir="zoomout" title="Zoom Out">−<span class="ptz-label">Zoom Out</span></button>
        </div>
        <div class="controls-bar__toolbar">
          <button class="toolbar-btn snapshot-btn" data-cam="${i}" title="Take Snapshot">${ICONS.snapshot}<span class="toolbar-hint">Snapshot</span></button>
          <span class="toolbar-sep"></span>
          <select class="toolbar-select ir-select" data-cam="${i}" title="Night Vision">
            <option value="auto">IR: Auto</option>
            <option value="on">IR: On</option>
            <option value="off">IR: Off</option>
          </select>
          <button class="toolbar-btn toolbar-toggle led-toggle" data-cam="${i}" title="Status LED">LED</button>
          <button class="toolbar-btn toolbar-toggle hdr-toggle" data-cam="${i}" title="HDR Mode">HDR</button>
          <span class="toolbar-sep"></span>
          <select class="toolbar-select preset-select" data-cam="${i}" title="PTZ Preset">
            <option value="" disabled selected>Preset</option>
            <option value="-1">Home</option>
            <option value="0">Preset 1</option>
            <option value="1">Preset 2</option>
            <option value="2">Preset 3</option>
          </select>
        </div>
      </div>
      ` : ''}
    </div>`;
  }).join('');

  // Bind quality selectors
  grid.querySelectorAll('.quality-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.cam);
      currentQualities[idx] = e.target.value;
      retryCount[idx] = 0;
      startStream(idx, e.target.value);
    });
  });

  // Bind expand buttons
  grid.querySelectorAll('.camera-card__expand').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.cam);
      openLightbox(idx);
    });
  });

  // Bind PTZ buttons (press and hold for continuous, release to stop)
  grid.querySelectorAll('.ptz-btn').forEach(btn => {
    bindPtzButton(btn);
  });

  // Bind toolbar controls
  grid.querySelectorAll('.snapshot-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.cam);
      takeSnapshot(cameras[idx]);
    });
  });

  grid.querySelectorAll('.ir-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.cam);
      updateCameraSetting(cameras[idx], { irLedMode: e.target.value });
    });
  });

  grid.querySelectorAll('.led-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.cam);
      const cam = cameras[idx];
      const current = cameraSettings[cam.protectCameraId]?.statusLightEnabled;
      updateCameraSetting(cam, { statusLightEnabled: !current });
    });
  });

  grid.querySelectorAll('.hdr-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.cam);
      const cam = cameras[idx];
      const current = cameraSettings[cam.protectCameraId]?.hdrModeEnabled;
      updateCameraSetting(cam, { hdrModeEnabled: !current });
    });
  });

  grid.querySelectorAll('.preset-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.cam);
      const slot = parseInt(e.target.value);
      if (!isNaN(slot)) {
        sendPtzCommand(idx, 'goto', slot);
        // Reset dropdown to placeholder
        e.target.selectedIndex = 0;
      }
    });
  });

  // Also allow clicking on video container to open lightbox
  grid.querySelectorAll('.camera-card__video').forEach(container => {
    container.addEventListener('dblclick', (e) => {
      if (e.target.closest('.ptz-btn') || e.target.closest('.camera-card__expand')) return;
      const idx = parseInt(container.dataset.cam);
      openLightbox(idx);
    });
  });

  // Start all streams at low quality (or snapshot refresh for Blink)
  cameras.forEach((cam, i) => {
    if (cam.model === 'Blink') {
      startBlinkSnapshotRefresh(i);
      return;
    }
    const defaultQuality = cam.streams.low ? 'low' : (cam.streams.med ? 'med' : 'high');
    currentQualities[i] = defaultQuality;
    const select = grid.querySelector(`.quality-select[data-cam="${i}"]`);
    if (select) select.value = defaultQuality;
    startStream(i, defaultQuality);
  });
}

// =============================================
// STREAM PLAYBACK — WebRTC (primary) + HLS (fallback)
// =============================================
const activeStreams = {};  // track active RTCPeerConnection or Hls instances
const activeHls = {};      // legacy alias for HLS-only cleanup paths
const retryCount = {};     // retry counter per camera
const MAX_RETRIES = 8;     // ~40s of retrying (5s intervals)

/**
 * Start a WebRTC stream via go2rtc's /api/webrtc endpoint.
 * Returns the RTCPeerConnection on success, throws on failure.
 */
async function startWebRTC(video, streamName, proxyBase) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  // Receive video + audio tracks
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = (event) => {
    if (video.srcObject !== event.streams[0]) {
      video.srcObject = event.streams[0];
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const res = await fetch(`${proxyBase}/api/webrtc?src=${streamName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offer.sdp,
  });

  if (!res.ok) throw new Error(`WebRTC signaling failed: ${res.status}`);

  const answerSdp = await res.text();
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerSdp }));

  return pc;
}

/**
 * Start an HLS stream (fallback when WebRTC fails).
 */
function startHLS(video, hlsUrl, hlsKey, camIndex, quality, videoElementId, overlay, dot) {
  if (typeof Hls === 'undefined') return null;

  if (Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 30,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      manifestLoadingMaxRetry: 10,
      manifestLoadingRetryDelay: 3000,
      manifestLoadingMaxRetryTimeout: 30000,
      levelLoadingMaxRetry: 10,
      levelLoadingRetryDelay: 3000,
      fragLoadingMaxRetry: 10,
      fragLoadingRetryDelay: 3000,
    });
    activeHls[hlsKey] = hls;
    activeStreams[hlsKey] = hls;

    hls.loadSource(hlsUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      retryCount[hlsKey] = 0;
      if (overlay) overlay.classList.add('hidden');
      if (dot) dot.className = 'status-dot status-live';
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        console.warn(`[Camera ${camIndex}] HLS media error, attempting recovery`);
        hls.recoverMediaError();
        return;
      }

      hls.destroy();
      delete activeHls[hlsKey];
      delete activeStreams[hlsKey];

      if (retryCount[hlsKey] < MAX_RETRIES) {
        retryCount[hlsKey]++;
        setTimeout(() => startStream(camIndex, quality, videoElementId), 5000);
      } else {
        if (overlay) {
          overlay.classList.remove('hidden');
          const loadingEl = overlay.querySelector('.camera-card__loading') || overlay;
          loadingEl.textContent = 'Stream offline';
        }
        if (dot) dot.className = 'status-dot status-offline';
        retryCount[hlsKey] = 0;
        setTimeout(() => startStream(camIndex, quality, videoElementId), 30000);
      }
    });
    return hls;
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS (Safari/iOS)
    video.src = hlsUrl;
    video.addEventListener('loadedmetadata', () => {
      retryCount[hlsKey] = 0;
      if (overlay) overlay.classList.add('hidden');
      if (dot) dot.className = 'status-dot status-live';
      video.play().catch(() => {});
    }, { once: true });
    video.addEventListener('error', () => {
      if (retryCount[hlsKey] < MAX_RETRIES) {
        retryCount[hlsKey]++;
        setTimeout(() => startStream(camIndex, quality, videoElementId), 5000);
      } else {
        if (overlay) {
          overlay.classList.remove('hidden');
          const loadingEl = overlay.querySelector('.camera-card__loading') || overlay;
          loadingEl.textContent = 'Stream offline';
        }
        if (dot) dot.className = 'status-dot status-offline';
        retryCount[hlsKey] = 0;
        setTimeout(() => startStream(camIndex, quality, videoElementId), 30000);
      }
    }, { once: true });
    return 'native';
  }
  return null;
}

/**
 * Clean up an active stream (WebRTC or HLS).
 */
function cleanupStream(key) {
  const instance = activeStreams[key];
  if (!instance) return;

  if (instance instanceof RTCPeerConnection) {
    instance.close();
  } else if (instance && typeof instance.destroy === 'function') {
    instance.destroy();
  }
  delete activeStreams[key];
  delete activeHls[key];
}

function startStream(camIndex, quality, videoElementId) {
  const cam = cameras[camIndex];
  const stream = cam.streams[quality];
  if (!stream) return;

  const videoId = videoElementId || `video-${camIndex}`;
  const video = document.getElementById(videoId);
  const overlayId = videoElementId ? 'lightbox-overlay-inner' : `overlay-${camIndex}`;
  const overlay = document.getElementById(overlayId);
  const dotId = videoElementId ? null : `dot-${camIndex}`;
  const dot = dotId ? document.getElementById(dotId) : null;
  if (!video) return;

  // Determine tracking key (grid uses camIndex, lightbox uses 'lb')
  const streamKey = videoElementId ? 'lb' : camIndex;

  // Clean up previous instance
  cleanupStream(streamKey);

  // Initialize retry counter
  if (retryCount[streamKey] === undefined) retryCount[streamKey] = 0;

  if (overlay) {
    overlay.classList.remove('hidden');
    const retries = retryCount[streamKey];
    const loadingEl = overlay.querySelector('.camera-card__loading') || overlay;
    if (loadingEl.classList) {
      loadingEl.textContent = retries === 0 ? 'Connecting...' : `Warming up camera... (${retries}/${MAX_RETRIES})`;
    }
  }
  if (dot) dot.className = 'status-dot status-connecting';

  // Try WebRTC first, fall back to HLS
  startWebRTC(video, stream.stream_name, stream.proxy_base_url)
    .then((pc) => {
      activeStreams[streamKey] = pc;
      retryCount[streamKey] = 0;
      if (overlay) overlay.classList.add('hidden');
      if (dot) dot.className = 'status-dot status-live';
      video.play().catch(() => {});

      // Monitor connection state
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          console.warn(`[Camera ${camIndex}] WebRTC ${pc.connectionState}, retrying...`);
          cleanupStream(streamKey);
          if (retryCount[streamKey] < MAX_RETRIES) {
            retryCount[streamKey]++;
            setTimeout(() => startStream(camIndex, quality, videoElementId), 5000);
          } else {
            if (overlay) {
              overlay.classList.remove('hidden');
              const loadingEl = overlay.querySelector('.camera-card__loading') || overlay;
              loadingEl.textContent = 'Stream offline';
            }
            if (dot) dot.className = 'status-dot status-offline';
            retryCount[streamKey] = 0;
            setTimeout(() => startStream(camIndex, quality, videoElementId), 30000);
          }
        }
      };
    })
    .catch((err) => {
      console.warn(`[Camera ${camIndex}] WebRTC failed, falling back to HLS:`, err.message);

      // Reset video.srcObject from WebRTC attempt
      video.srcObject = null;

      const hlsUrl = `${stream.proxy_base_url}/api/stream.m3u8?src=${stream.stream_name}&mp4`;
      const result = startHLS(video, hlsUrl, streamKey, camIndex, quality, videoElementId, overlay, dot);
      if (!result) {
        if (overlay) {
          const loadingEl = overlay.querySelector('.camera-card__loading') || overlay;
          loadingEl.textContent = 'Player not available';
        }
        if (dot) dot.className = 'status-dot status-offline';
      }
    });
}

// Clean up streams on page hide (save bandwidth)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const key of Object.keys(activeStreams)) {
      cleanupStream(key);
    }
  }
});

// =============================================
// BLINK SNAPSHOT REFRESH
// =============================================
function startBlinkSnapshotRefresh(camIndexOrKey) {
  // Supports grid cameras (numeric index) and lightbox ('lb')
  const isLightbox = camIndexOrKey === 'lb';
  const img = isLightbox
    ? document.getElementById('lb-blink-img')
    : document.getElementById(`blink-img-${camIndexOrKey}`);
  const timeEl = isLightbox ? null : document.getElementById(`blink-time-${camIndexOrKey}`);
  const dot = isLightbox ? null : document.getElementById(`dot-${camIndexOrKey}`);
  if (!img) return;

  function refreshSnapshot() {
    const url = `${BLINK_STORAGE_BASE}/${BLINK_SNAPSHOT_PATH}?t=${Date.now()}`;
    const tempImg = new Image();
    tempImg.onload = () => {
      img.src = url;
      img.style.opacity = '1';
      if (dot) dot.className = 'status-dot status-live';
      if (timeEl) timeEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    };
    tempImg.onerror = () => {
      if (dot) dot.className = 'status-dot status-connecting';
      if (timeEl) timeEl.textContent = 'Snapshot unavailable';
    };
    tempImg.src = url;
  }

  // Initial load
  refreshSnapshot();

  // Periodic refresh
  if (blinkRefreshIntervals[camIndexOrKey]) clearInterval(blinkRefreshIntervals[camIndexOrKey]);
  blinkRefreshIntervals[camIndexOrKey] = setInterval(refreshSnapshot, BLINK_REFRESH_MS);
}

function stopBlinkSnapshotRefresh(camIndex) {
  if (blinkRefreshIntervals[camIndex]) {
    clearInterval(blinkRefreshIntervals[camIndex]);
    delete blinkRefreshIntervals[camIndex];
  }
}

// =============================================
// PTZ CONTROLS
// =============================================
function bindPtzButton(btn) {
  const dir = btn.dataset.dir;

  if (dir === 'home') {
    // Home is a single click action
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.cam);
      sendPtzCommand(idx, 'home');
    });
    return;
  }

  // Continuous move: start on mousedown/touchstart, stop on mouseup/touchend
  let pressing = false;

  const startPress = (e) => {
    e.preventDefault();
    pressing = true;
    const idx = parseInt(btn.dataset.cam);
    sendPtzCommand(idx, dir);
    btn.classList.add('active');
  };

  const endPress = (e) => {
    e.preventDefault();
    if (!pressing) return;
    pressing = false;
    const idx = parseInt(btn.dataset.cam);
    sendPtzCommand(idx, 'stop');
    btn.classList.remove('active');
  };

  btn.addEventListener('mousedown', startPress);
  btn.addEventListener('touchstart', startPress, { passive: false });
  document.addEventListener('mouseup', endPress);
  document.addEventListener('touchend', endPress);
  btn.addEventListener('mouseleave', () => {
    if (pressing) {
      pressing = false;
      const idx = parseInt(btn.dataset.cam);
      sendPtzCommand(idx, 'stop');
      btn.classList.remove('active');
    }
  });
}

async function sendPtzCommand(camIndex, direction, slot) {
  const cam = cameras[camIndex];
  if (!cam || !cam.protectCameraId) {
    showToast('PTZ not available for this camera', 'error');
    return;
  }

  const speed = 500; // moderate speed out of -750 to 750 range
  let payload;

  switch (direction) {
    case 'up':
      payload = { action: 'move', x: 0, y: speed, z: 0 };
      break;
    case 'down':
      payload = { action: 'move', x: 0, y: -speed, z: 0 };
      break;
    case 'left':
      payload = { action: 'move', x: -speed, y: 0, z: 0 };
      break;
    case 'right':
      payload = { action: 'move', x: speed, y: 0, z: 0 };
      break;
    case 'zoomin':
      payload = { action: 'move', x: 0, y: 0, z: speed };
      break;
    case 'zoomout':
      payload = { action: 'move', x: 0, y: 0, z: -speed };
      break;
    case 'stop':
      payload = { action: 'move', x: 0, y: 0, z: 0 };
      break;
    case 'home':
      payload = { action: 'goto', slot: -1 };
      break;
    case 'goto':
      payload = { action: 'goto', slot: slot ?? -1 };
      break;
    default:
      return;
  }

  try {
    const resp = await fetch(`${PTZ_PROXY_BASE}/${cam.protectCameraId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('PTZ error:', err);
      if (direction !== 'stop') {
        showToast('PTZ command failed', 'error');
      }
    }
  } catch (err) {
    console.error('PTZ network error:', err);
    if (direction !== 'stop') {
      showToast('PTZ unavailable', 'error');
    }
  }
}

// =============================================
// LIGHTBOX
// =============================================
let lightboxOpen = false;
let lightboxCamIndex = 0;
let lightboxQuality = null; // null = use same as grid

function renderLightbox() {
  // Create lightbox overlay (once)
  const lb = document.createElement('div');
  lb.id = 'cameraLightbox';
  lb.className = 'camera-lightbox hidden';
  lb.innerHTML = `
    <div class="camera-lightbox__backdrop"></div>
    <div class="camera-lightbox__content">
      <div class="camera-lightbox__header">
        <div class="camera-lightbox__title">
          <span class="status-dot" id="lb-dot"></span>
          <span id="lb-name"></span>
          <span id="lb-location" style="font-weight:400;color:var(--text-muted);font-size:0.75rem;margin-left:0.5rem"></span>
        </div>
        <div class="camera-lightbox__header-controls">
          <select class="quality-select" id="lb-quality">
            <option value="low">Low</option>
            <option value="med" selected>Med</option>
            <option value="high">High</option>
          </select>
          <button class="camera-lightbox__close" id="lb-close" title="Close (Esc)">✕</button>
        </div>
      </div>
      <div class="camera-lightbox__toolbar" id="lb-toolbar">
        <button class="toolbar-btn" id="lb-snapshot" title="Take Snapshot">${ICONS.snapshot} Snapshot</button>
        <span class="toolbar-sep"></span>
        <div class="toolbar-group">
          <span class="toolbar-label">Night Vision</span>
          <select class="toolbar-select" id="lb-ir-mode">
            <option value="auto">Auto</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </div>
        <div class="toolbar-group">
          <span class="toolbar-label">LED</span>
          <button class="toolbar-btn toolbar-toggle" id="lb-led-toggle">Off</button>
        </div>
        <div class="toolbar-group">
          <span class="toolbar-label">HDR</span>
          <button class="toolbar-btn toolbar-toggle" id="lb-hdr-toggle">Off</button>
        </div>
        <span class="toolbar-sep"></span>
        <div class="toolbar-group">
          <span class="toolbar-label">Preset</span>
          <select class="toolbar-select" id="lb-preset">
            <option value="" disabled selected>Go to...</option>
            <option value="-1">Home</option>
            <option value="0">Preset 1</option>
            <option value="1">Preset 2</option>
            <option value="2">Preset 3</option>
          </select>
        </div>
      </div>
      <div class="camera-lightbox__video-wrap">
        <button class="camera-lightbox__nav camera-lightbox__nav--prev" id="lb-prev" title="Previous camera (←)">‹</button>
        <div class="camera-lightbox__video-container">
          <video id="lb-video" muted autoplay playsinline></video>
          <div class="camera-card__overlay" id="lightbox-overlay-inner">
            <div class="camera-card__loading">Connecting...</div>
          </div>
        </div>
        <button class="camera-lightbox__nav camera-lightbox__nav--next" id="lb-next" title="Next camera (→)">›</button>
      </div>
      <div class="camera-lightbox__ptz" id="lb-ptz">
        <button class="ptz-btn ptz-up" data-dir="up" title="Tilt Up">▲</button>
        <button class="ptz-btn ptz-left" data-dir="left" title="Pan Left">◀</button>
        <button class="ptz-btn ptz-home" data-dir="home" title="Home Position">⌂</button>
        <button class="ptz-btn ptz-right" data-dir="right" title="Pan Right">▶</button>
        <button class="ptz-btn ptz-down" data-dir="down" title="Tilt Down">▼</button>
        <button class="ptz-btn ptz-zoomin" data-dir="zoomin" title="Zoom In">+<span class="ptz-label">Zoom In</span></button>
        <button class="ptz-btn ptz-zoomout" data-dir="zoomout" title="Zoom Out">−<span class="ptz-label">Zoom Out</span></button>
      </div>
    </div>
  `;
  document.body.appendChild(lb);

  // Bind lightbox controls
  document.getElementById('lb-close').addEventListener('click', closeLightbox);
  lb.querySelector('.camera-lightbox__backdrop').addEventListener('click', closeLightbox);
  document.getElementById('lb-prev').addEventListener('click', () => navigateLightbox(-1));
  document.getElementById('lb-next').addEventListener('click', () => navigateLightbox(1));

  // Quality selector
  document.getElementById('lb-quality').addEventListener('change', (e) => {
    lightboxQuality = e.target.value;
    retryCount['lb'] = 0;
    startStream(lightboxCamIndex, lightboxQuality, 'lb-video');
  });

  // Lightbox toolbar controls
  document.getElementById('lb-snapshot').addEventListener('click', () => {
    takeSnapshot(cameras[lightboxCamIndex]);
  });

  document.getElementById('lb-ir-mode').addEventListener('change', (e) => {
    updateCameraSetting(cameras[lightboxCamIndex], { irLedMode: e.target.value });
  });

  document.getElementById('lb-led-toggle').addEventListener('click', () => {
    const cam = cameras[lightboxCamIndex];
    const current = cameraSettings[cam.protectCameraId]?.statusLightEnabled;
    updateCameraSetting(cam, { statusLightEnabled: !current });
  });

  document.getElementById('lb-hdr-toggle').addEventListener('click', () => {
    const cam = cameras[lightboxCamIndex];
    const current = cameraSettings[cam.protectCameraId]?.hdrModeEnabled;
    updateCameraSetting(cam, { hdrModeEnabled: !current });
  });

  document.getElementById('lb-preset').addEventListener('change', (e) => {
    const slot = parseInt(e.target.value);
    if (!isNaN(slot)) {
      sendPtzCommand(lightboxCamIndex, 'goto', slot);
      e.target.selectedIndex = 0;
    }
  });

  // PTZ in lightbox
  lb.querySelectorAll('#lb-ptz .ptz-btn').forEach(btn => {
    const dir = btn.dataset.dir;
    if (dir === 'home') {
      btn.addEventListener('click', () => sendPtzCommand(lightboxCamIndex, 'home'));
      return;
    }
    let pressing = false;
    const startPress = (e) => {
      e.preventDefault();
      pressing = true;
      sendPtzCommand(lightboxCamIndex, dir);
      btn.classList.add('active');
    };
    const endPress = (e) => {
      e.preventDefault();
      if (!pressing) return;
      pressing = false;
      sendPtzCommand(lightboxCamIndex, 'stop');
      btn.classList.remove('active');
    };
    btn.addEventListener('mousedown', startPress);
    btn.addEventListener('touchstart', startPress, { passive: false });
    document.addEventListener('mouseup', endPress);
    document.addEventListener('touchend', endPress);
    btn.addEventListener('mouseleave', () => {
      if (pressing) {
        pressing = false;
        sendPtzCommand(lightboxCamIndex, 'stop');
        btn.classList.remove('active');
      }
    });
  });
}

function openLightbox(camIndex) {
  lightboxOpen = true;
  lightboxCamIndex = camIndex;
  const cam = cameras[camIndex];

  // Use current grid quality or default
  lightboxQuality = currentQualities[camIndex] || 'med';

  // Update UI
  document.getElementById('lb-name').textContent = cam.name;
  document.getElementById('lb-location').textContent = cam.location || '';

  // Update quality dropdown options based on available streams
  const qualitySelect = document.getElementById('lb-quality');
  qualitySelect.innerHTML = '';
  if (cam.streams.low) qualitySelect.innerHTML += '<option value="low">Low</option>';
  if (cam.streams.med) qualitySelect.innerHTML += '<option value="med">Med</option>';
  if (cam.streams.high) qualitySelect.innerHTML += '<option value="high">High</option>';
  qualitySelect.value = lightboxQuality;

  // Show/hide PTZ and toolbar based on camera support
  const hasPtz = !!cam.protectCameraId;
  document.getElementById('lb-ptz').style.display = hasPtz ? '' : 'none';
  document.getElementById('lb-toolbar').style.display = hasPtz ? '' : 'none';

  // Update toolbar with current settings
  if (hasPtz) {
    const s = cameraSettings[cam.protectCameraId];
    if (s) {
      document.getElementById('lb-ir-mode').value = s.irLedMode || 'auto';
      const ledBtn = document.getElementById('lb-led-toggle');
      ledBtn.classList.toggle('active', !!s.statusLightEnabled);
      ledBtn.textContent = s.statusLightEnabled ? 'On' : 'Off';
      const hdrBtn = document.getElementById('lb-hdr-toggle');
      hdrBtn.classList.toggle('active', !!s.hdrModeEnabled);
      hdrBtn.textContent = s.hdrModeEnabled ? 'On' : 'Off';
    }
    // Also refresh settings from API
    fetchCameraSettings(cam);
  }

  // Show/hide nav buttons
  document.getElementById('lb-prev').style.visibility = cameras.length > 1 ? 'visible' : 'hidden';
  document.getElementById('lb-next').style.visibility = cameras.length > 1 ? 'visible' : 'hidden';

  // Show lightbox
  document.getElementById('cameraLightbox').classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Handle Blink snapshot vs HLS stream
  const lbVideo = document.getElementById('lb-video');
  let lbBlinkImg = document.getElementById('lb-blink-img');

  if (cam.model === 'Blink') {
    // Hide video, show snapshot image
    if (lbVideo) lbVideo.style.display = 'none';
    if (!lbBlinkImg) {
      lbBlinkImg = document.createElement('img');
      lbBlinkImg.id = 'lb-blink-img';
      lbBlinkImg.className = 'blink-snapshot-img';
      lbBlinkImg.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#111';
      lbVideo.parentNode.insertBefore(lbBlinkImg, lbVideo);
    }
    lbBlinkImg.style.display = 'block';
    lbBlinkImg.src = `${BLINK_STORAGE_BASE}/${BLINK_SNAPSHOT_PATH}?t=${Date.now()}`;
    // Start refresh in lightbox
    startBlinkSnapshotRefresh('lb');
  } else {
    // Standard HLS - hide Blink image if present
    if (lbVideo) lbVideo.style.display = '';
    if (lbBlinkImg) lbBlinkImg.style.display = 'none';
    retryCount['lb'] = 0;
    startStream(camIndex, lightboxQuality, 'lb-video');
  }
}

function closeLightbox() {
  lightboxOpen = false;
  document.getElementById('cameraLightbox').classList.add('hidden');
  document.body.style.overflow = '';

  // Clean up Blink snapshot refresh in lightbox
  stopBlinkSnapshotRefresh('lb');

  // Clean up lightbox HLS
  if (activeHls['lb']) {
    activeHls['lb'].destroy();
    delete activeHls['lb'];
  }
}

function navigateLightbox(delta) {
  if (!cameras.length) return;
  lightboxCamIndex = (lightboxCamIndex + delta + cameras.length) % cameras.length;
  openLightbox(lightboxCamIndex);
}

// =============================================
// KEYBOARD SHORTCUTS
// =============================================
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (!lightboxOpen) return;

    switch (e.key) {
      case 'Escape':
        closeLightbox();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        navigateLightbox(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        navigateLightbox(1);
        break;
    }
  });
}

// =============================================
// ENVIRONMENT SENSORS (UP-SENSE)
// =============================================
const SENSOR_ICONS = {
  temperature: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>',
  humidity: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>',
  light: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
  door: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2h11a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><circle cx="14" cy="12" r="1"/></svg>',
  motion: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3"/><path d="M13 20h9"/><path d="M10 12v8"/><path d="M13 8v12"/><path d="M7 16v4"/><path d="M4 12v8"/></svg>',
  alarm: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  battery: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/></svg>',
};

let sensors = [];
let sensorPollTimer = null;
let lastSensorPollTime = null;

async function loadSensors() {
  // Load metadata from DB
  const { data, error } = await supabase
    .from('protect_sensors')
    .select('*')
    .eq('is_active', true)
    .order('display_order');

  if (error || !data?.length) {
    sensors = [];
    return;
  }

  const scopedData = (deviceScope && !deviceScope.fullAccess)
    ? data.filter((meta) =>
      deviceScope.canAccessSpaceId(meta.space_id)
      || deviceScope.canAccessSpaceName(meta.location)
      || deviceScope.canAccessSpaceName(meta.name)
    )
    : data;

  // Fetch live state from proxy
  try {
    const resp = await fetch(SENSORS_PROXY_BASE);
    if (!resp.ok) throw new Error(`Sensor fetch failed: ${resp.status}`);
    const sensorStates = await resp.json();

    sensors = scopedData.map(meta => {
      const state = sensorStates.find(s => s.id === meta.protect_sensor_id);
      return { meta, state: state || null };
    });
  } catch (err) {
    console.warn('Failed to load sensor states:', err.message);
    sensors = scopedData.map(meta => ({ meta, state: null }));
  }
}

async function refreshSensorStates() {
  if (!sensors.length) return;
  try {
    const resp = await fetch(SENSORS_PROXY_BASE);
    if (!resp.ok) return;
    const sensorStates = await resp.json();
    for (const s of sensors) {
      const state = sensorStates.find(st => st.id === s.meta.protect_sensor_id);
      if (state) s.state = state;
    }
  } catch (err) {
    console.warn('Sensor refresh failed:', err.message);
  }
  lastSensorPollTime = new Date();
  updateSensorPollStatus();
}

function startSensorPolling() {
  if (!sensors.length) return;
  sensorPollTimer = setInterval(async () => {
    if (document.hidden) return;
    await refreshSensorStates();
    renderSensors();
  }, 30000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && sensors.length) {
      refreshSensorStates().then(renderSensors);
    }
  });
}

function startLocalClock() {
  const el = document.getElementById('localTime');
  if (!el) return;
  const update = () => {
    el.textContent = 'Time in Austin, Texas: ' + new Date().toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', second: '2-digit',
      timeZone: 'America/Chicago'
    });
  };
  update();
  setInterval(update, 1000);
}

function updateSensorPollStatus() {
  const el = document.getElementById('sensorPollStatus');
  if (!el || !lastSensorPollTime) return;
  const timeStr = lastSensorPollTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.textContent = `Last updated: ${timeStr}`;
}

function getSensorTemp(state) {
  // Try stats.temperature.value (Celsius) first, then top-level temperatureLevel
  const tempC = state?.stats?.temperature?.value ?? state?.temperatureLevel ?? null;
  if (tempC == null) return '--';
  return ((tempC * 9 / 5) + 32).toFixed(1);
}

function getSensorHumidity(state) {
  return state?.stats?.humidity?.value ?? state?.humidityLevel ?? '--';
}

function getSensorLight(state) {
  return state?.stats?.light?.value ?? state?.lightLevel ?? '--';
}

function renderSensors() {
  const section = document.getElementById('sensorsSection');
  const container = document.getElementById('sensorGrid');
  if (!section || !container) return;

  if (!sensors.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  container.innerHTML = sensors.map(({ meta, state }) => {
    if (!state) {
      return `<div class="sensor-card sensor-card--offline">
        <div class="sensor-card__header">
          <span class="status-dot status-offline"></span>
          <span class="sensor-card__name">${meta.name}</span>
        </div>
        <div class="sensor-card__body">
          <span class="text-muted" style="font-size:0.85rem">Sensor offline</span>
        </div>
      </div>`;
    }

    const tempF = getSensorTemp(state);
    const humidity = getSensorHumidity(state);
    const light = getSensorLight(state);
    const isOpen = state.isOpened;
    const isMotion = state.isMotionDetected;
    const batteryPct = state.batteryStatus?.percentage ?? '--';
    const batteryLow = state.batteryStatus?.isLow;
    const isConnected = state.isConnected !== false;
    const hasAlarm = state.alarmTriggeredAt &&
      (Date.now() - new Date(state.alarmTriggeredAt).getTime()) < 300000;

    // Only show door status if mount type suggests a contact sensor
    const showDoor = meta.mount_type === 'door' || meta.mount_type === 'window' || isOpen != null;

    return `<div class="sensor-card ${hasAlarm ? 'sensor-card--alarm' : ''} ${!isConnected ? 'sensor-card--offline' : ''}">
      <div class="sensor-card__header">
        <span class="status-dot ${isConnected ? 'status-live' : 'status-offline'}"></span>
        <span class="sensor-card__name">${meta.name}</span>
        ${meta.location ? `<span class="sensor-card__location">${meta.location}</span>` : ''}
        <span class="sensor-card__battery ${batteryLow ? 'battery-low' : ''}">
          ${SENSOR_ICONS.battery} ${batteryPct}%
        </span>
      </div>
      <div class="sensor-card__body">
        <div class="sensor-card__readings">
          <div class="sensor-reading">
            <span class="sensor-reading__icon">${SENSOR_ICONS.temperature}</span>
            <span class="sensor-reading__value">${tempF}</span>
            <span class="sensor-reading__unit">&deg;F</span>
          </div>
          <div class="sensor-reading">
            <span class="sensor-reading__icon">${SENSOR_ICONS.humidity}</span>
            <span class="sensor-reading__value">${humidity}</span>
            <span class="sensor-reading__unit">%</span>
          </div>
          <div class="sensor-reading">
            <span class="sensor-reading__icon">${SENSOR_ICONS.light}</span>
            <span class="sensor-reading__value">${light}</span>
            <span class="sensor-reading__unit">lux</span>
          </div>
        </div>
        <div class="sensor-card__statuses">
          ${showDoor ? `<span class="sensor-status ${isOpen ? 'sensor-status--open' : 'sensor-status--closed'}">
            ${SENSOR_ICONS.door} ${isOpen ? 'Open' : 'Closed'}
          </span>` : ''}
          <span class="sensor-status ${isMotion ? 'sensor-status--active' : ''}">
            ${SENSOR_ICONS.motion} ${isMotion ? 'Motion' : 'Clear'}
          </span>
          ${hasAlarm ? `<span class="sensor-status sensor-status--alarm">${SENSOR_ICONS.alarm} Alarm</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}


// =============================================
// RECENT EVENTS (Smart Detect)
// =============================================

// Camera ID → name map (built from loaded cameras)
function getCameraNameMap() {
  const map = {};
  for (const cam of cameras) {
    // cam.protectCameraId is set at the camera level during grouping
    if (cam.protectCameraId) map[cam.protectCameraId] = cam.name;
  }
  return map;
}

const DETECT_ICONS = {
  person: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="7" r="4"/><path d="M5.5 21v-2a6.5 6.5 0 0113 0v2"/></svg>',
  animal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 5.172C10 3.782 8.423 2.679 6.5 3c-2.823.47-4.113 6.006-4 7 .08.703 1.725 1.722 3.656 1 1.261-.472 1.96-1.45 2.344-2.5"/><path d="M14.267 5.172c0-1.39 1.577-2.493 3.5-2.172 2.823.47 4.113 6.006 4 7-.08.703-1.725 1.722-3.656 1-1.261-.472-1.855-1.45-2.239-2.5"/><path d="M8 14v.5"/><path d="M16 14v.5"/><path d="M11.25 16.25h1.5L12 17l-.75-.75Z"/><path d="M4.42 11.247A13.152 13.152 0 004 14.556C4 18.728 7.582 21 12 21s8-2.272 8-6.444a13.152 13.152 0 00-.42-3.31"/></svg>',
  vehicle: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 16H9m10 0h3v-3.15a1 1 0 00-.84-.99L16 11l-2.7-3.6a1 1 0 00-.8-.4H5.24a2 2 0 00-1.8 1.1l-.8 1.63A6 6 0 002 12.42V16h2"/><circle cx="6.5" cy="16.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/></svg>',
  package: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16Z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>',
};

function timeAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

const EVENTS_INITIAL = 40;
const EVENTS_MORE = 30;
let allEvents = [];
let eventsFirstLoad = true;
let eventDateFilter = { start: null, end: null };
let eventTypeFilter = 'all';
let selectedEventIdx = -1;

async function loadEvents(older) {
  const section = document.getElementById('eventsSection');
  const grid = document.getElementById('eventGrid');
  const moreBtn = document.getElementById('eventsMoreBtn');
  if (!section || !grid) return;

  try {
    const pageSize = eventsFirstLoad ? EVENTS_INITIAL : EVENTS_MORE;
    let url = `${EVENTS_PROXY_BASE}/events?limit=${pageSize}&types[]=motion&types[]=smartDetectZone&orderDirection=desc`;

    if (eventDateFilter.start) {
      url += `&start=${new Date(eventDateFilter.start).getTime()}`;
    }
    if (eventDateFilter.end) {
      url += `&end=${new Date(eventDateFilter.end + 'T23:59:59').getTime()}`;
    }

    if (older && allEvents.length) {
      const oldest = allEvents[allEvents.length - 1];
      url += `&end=${oldest.start - 1}`;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const events = await res.json();
    eventsFirstLoad = false;

    if (!older) allEvents = events;
    else allEvents = allEvents.concat(events);

    renderEvents();

    const expectedSize = older ? EVENTS_MORE : EVENTS_INITIAL;
    if (moreBtn) moreBtn.classList.toggle('hidden', events.length < expectedSize);
  } catch (err) {
    console.warn('[Events] Failed to load:', err.message);
  }
}

// Date picker — chip triggers hidden native date input
function initEventFilters() {
  const picker = document.getElementById('eventDatePicker');
  const chip = document.getElementById('eventDateChip');
  const label = document.getElementById('eventDateLabel');
  if (picker) {
    // Clicking chip opens native date picker
    if (chip) {
      chip.addEventListener('click', () => {
        try { picker.showPicker(); } catch { picker.focus(); picker.click(); }
      });
    }
    picker.addEventListener('change', () => {
      const v = picker.value;
      if (v) {
        eventDateFilter = { start: v, end: v };
        // Format as "Mar 10, 2026"
        const d = new Date(v + 'T12:00:00');
        const formatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        if (label) label.textContent = formatted;
        chip?.classList.add('has-date');
        document.getElementById('eventDateClear')?.classList.remove('hidden');
      } else {
        eventDateFilter = { start: null, end: null };
        if (label) label.textContent = 'Date';
        chip?.classList.remove('has-date');
        document.getElementById('eventDateClear')?.classList.add('hidden');
      }
      allEvents = [];
      eventsFirstLoad = true;
      selectedEventIdx = -1;
      loadEvents(false);
    });
  }

  // Type filter buttons
  const typeBtns = document.getElementById('evtTypeFilters');
  if (typeBtns) {
    typeBtns.addEventListener('click', (e) => {
      const btn = e.target.closest('.evt-type-btn');
      if (!btn) return;
      typeBtns.querySelectorAll('.evt-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      eventTypeFilter = btn.dataset.type;
      renderEvents();
    });
  }
}

window.__clearEventDateFilter = function() {
  const picker = document.getElementById('eventDatePicker');
  if (picker) picker.value = '';
  eventDateFilter = { start: null, end: null };
  const label = document.getElementById('eventDateLabel');
  if (label) label.textContent = 'Date';
  document.getElementById('eventDateChip')?.classList.remove('has-date');
  document.getElementById('eventDateClear')?.classList.add('hidden');
  allEvents = [];
  eventsFirstLoad = true;
  selectedEventIdx = -1;
  loadEvents(false);
};

function getFilteredEvents() {
  if (eventTypeFilter === 'all') return allEvents;
  return allEvents.filter(ev => {
    const types = ev.smartDetectTypes && ev.smartDetectTypes.length ? ev.smartDetectTypes : [ev.type || 'motion'];
    return types.includes(eventTypeFilter);
  });
}

function formatEventTime(ms) {
  const d = new Date(ms);
  const mon = d.toLocaleString('en-US', { month: 'short' });
  const day = d.getDate();
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${mon} ${day}, ${h12}:${m} ${ampm}`;
}

const DETECT_BADGE_ICONS = {
  person: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="7" r="4"/><path d="M5.5 21v-2a6.5 6.5 0 0113 0v2"/></svg>',
  animal: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10 5.172C10 3.782 8.423 2.679 6.5 3c-2.823.47-4.113 6.006-4 7 .08.703 1.725 1.722 3.656 1 1.261-.472 1.96-1.45 2.344-2.5"/><path d="M14.267 5.172c0-1.39 1.577-2.493 3.5-2.172 2.823.47 4.113 6.006 4 7-.08.703-1.725 1.722-3.656 1-1.261-.472-1.855-1.45-2.239-2.5"/><path d="M8 14v.5M16 14v.5"/><path d="M11.25 16.25h1.5L12 17l-.75-.75Z"/><path d="M4.42 11.247A13.152 13.152 0 004 14.556C4 18.728 7.582 21 12 21s8-2.272 8-6.444a13.152 13.152 0 00-.42-3.31"/></svg>',
  vehicle: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 16H9m10 0h3v-3.15a1 1 0 00-.84-.99L16 11l-2.7-3.6a1 1 0 00-.8-.4H5.24a2 2 0 00-1.8 1.1l-.8 1.63A6 6 0 002 12.42V16h2"/><circle cx="6.5" cy="16.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/></svg>',
  package: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16Z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>',
};

function renderEvents() {
  const section = document.getElementById('eventsSection');
  const grid = document.getElementById('eventGrid');
  if (!section || !grid || !allEvents.length) return;

  section.style.display = '';
  const filtered = getFilteredEvents();

  grid.innerHTML = filtered.map((ev, i) => {
    const types = ev.smartDetectTypes && ev.smartDetectTypes.length ? ev.smartDetectTypes : [ev.type || 'motion'];
    const mainType = types[0];
    const thumbUrl = ev.thumbnail ? `${EVENTS_PROXY_BASE}/thumbnail/${ev.thumbnail}` : '';
    const timeLabel = formatEventTime(ev.start);

    const typeDots = types.filter(t => t !== 'motion').map(t =>
      `<span class="evt-thumb__badge evt-thumb__badge--${t}" title="${t}">${DETECT_BADGE_ICONS[t] || ''}</span>`
    ).join('');

    return `<div class="evt-thumb${i === selectedEventIdx ? ' evt-thumb--active' : ''}" data-idx="${i}" data-camera="${ev.camera}" data-start="${ev.start}" data-end="${ev.end}" onclick="window.__selectEvent(${i})">
      ${thumbUrl
        ? `<img src="${thumbUrl}" alt="${mainType}" loading="lazy">`
        : `<div class="evt-thumb__empty">${DETECT_ICONS[mainType] || '?'}</div>`}
      <div class="evt-thumb__time">${timeLabel}</div>
      ${typeDots ? `<div class="evt-thumb__badges">${typeDots}</div>` : ''}
    </div>`;
  }).join('');

  // Auto-select first if none selected
  if (selectedEventIdx < 0 && filtered.length) {
    window.__selectEvent(0);
  }
}

window.__selectEvent = function(idx) {
  const filtered = getFilteredEvents();
  const ev = filtered[idx];
  if (!ev) return;
  selectedEventIdx = idx;

  // Update active state
  document.querySelectorAll('.evt-thumb').forEach((el, i) => {
    el.classList.toggle('evt-thumb--active', i === idx);
  });

  // Scroll active into view in the grid
  const activeEl = document.querySelector('.evt-thumb--active');
  if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Update preview
  const cameraNames = getCameraNameMap();
  const cameraName = cameraNames[ev.camera] || 'Camera';
  const types = ev.smartDetectTypes && ev.smartDetectTypes.length ? ev.smartDetectTypes : [ev.type || 'motion'];
  const thumbUrl = ev.thumbnail ? `${EVENTS_PROXY_BASE}/thumbnail/${ev.thumbnail}` : '';
  const score = ev.score != null ? ev.score : '';
  const durationSec = ev.end && ev.start ? Math.round((ev.end - ev.start) / 1000) : 0;

  const previewImg = document.getElementById('evtPreviewImg');
  const previewMeta = document.getElementById('evtPreviewMeta');
  const previewEmpty = document.getElementById('evtPreviewEmpty');
  const previewPlay = document.getElementById('evtPreviewPlay');

  if (thumbUrl && previewImg) {
    previewImg.src = thumbUrl;
    previewImg.classList.remove('hidden');
    previewEmpty?.classList.add('hidden');
  } else {
    previewImg?.classList.add('hidden');
    previewEmpty?.classList.remove('hidden');
  }

  if (previewMeta) {
    const typeBadges = types.map(t =>
      `<span class="event-badge event-badge--${t}">${DETECT_ICONS[t] || ''} ${t}</span>`
    ).join('');
    previewMeta.innerHTML = `
      <div class="evt-preview__badges">${typeBadges}</div>
      <div class="evt-preview__details">
        <span class="evt-preview__camera">${cameraName}</span>
        <span class="evt-preview__time">${formatEventTime(ev.start)}</span>
        ${durationSec ? `<span class="evt-preview__dur">${durationSec}s</span>` : ''}
        ${score ? `<span class="evt-preview__score">${score}%</span>` : ''}
      </div>`;
    previewMeta.classList.remove('hidden');
  }

  if (previewPlay) {
    previewPlay.classList.remove('hidden');
    previewPlay.onclick = () => {
      // Reuse existing __playClip with a fake card element
      const fakeCard = document.createElement('div');
      fakeCard.className = 'event-card';
      fakeCard.dataset.camera = ev.camera;
      fakeCard.dataset.start = ev.start;
      fakeCard.dataset.end = ev.end;
      const fakeBtn = document.createElement('button');
      fakeCard.appendChild(fakeBtn);
      window.__playClip(fakeBtn);
    };
  }
};

window.__loadMoreEvents = function(btn) {
  btn.textContent = 'Loading...';
  btn.disabled = true;
  loadEvents(true).finally(() => {
    btn.textContent = 'Load More';
    btn.disabled = false;
  });
};

// Inline video player — streams clip directly from ptz-proxy (no blob buffering)
window.__playClip = function(btn) {
  const card = btn.closest('.event-card');
  if (!card) return;
  const camera = card.dataset.camera;
  const start = card.dataset.start;
  const end = card.dataset.end;
  if (!camera || !start || !end) return;

  const src = `${EVENTS_PROXY_BASE}/export?camera=${camera}&start=${start}&end=${end}`;

  // Remove existing overlay if any
  document.getElementById('videoOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'videoOverlay';
  overlay.className = 'video-overlay';
  overlay.innerHTML = `
    <div class="video-overlay__backdrop"></div>
    <div class="video-overlay__container">
      <div class="video-overlay__loading" id="videoLoading">
        <div class="video-overlay__progress-text" id="videoProgressText">Loading clip…</div>
      </div>
      <video class="video-overlay__player" id="videoPlayer" controls playsinline style="display:none"></video>
      <button class="video-overlay__close" aria-label="Close">&times;</button>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => {
    const v = overlay.querySelector('video');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    overlay.remove();
  };
  overlay.querySelector('.video-overlay__backdrop').addEventListener('click', close);
  overlay.querySelector('.video-overlay__close').addEventListener('click', close);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  // Stream directly — browser handles buffering via HTTP chunked transfer
  const loading = document.getElementById('videoLoading');
  const player = document.getElementById('videoPlayer');

  if (player) {
    player.src = src;

    player.addEventListener('canplay', () => {
      if (loading) loading.style.display = 'none';
      player.style.display = '';
      player.play().catch(() => {});
    }, { once: true });

    player.addEventListener('error', () => {
      const textEl = document.getElementById('videoProgressText');
      if (textEl) textEl.textContent = 'Failed to load clip';
      console.warn('[Video] Stream error for:', src);
    }, { once: true });
  }
};
