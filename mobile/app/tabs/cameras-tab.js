/**
 * Cameras Tab - Mobile HLS camera feeds
 * Shows camera cards with live video via HLS.js, quality switching.
 * HLS.js is lazy-loaded when this tab is first opened to improve initial app load.
 */

import { loadCameras, buildHlsUrl } from '../../../shared/services/camera-data.js';

const HLS_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js';

let cameras = [];
let hlsInstances = {}; // { camIndex: Hls instance }
let currentQualities = {}; // { camIndex: 'low'|'med'|'high' }
let retryTimers = {}; // { camIndex: timer }

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
let retryCounts = {};

/** Load HLS.js script once; resolves when window.Hls is available. */
function loadHlsScript() {
  if (typeof window.Hls !== 'undefined') return Promise.resolve();
  const existing = document.querySelector(`script[src="${HLS_SCRIPT_URL}"]`);
  if (existing) {
    return new Promise((resolve) => {
      if (window.Hls) return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = HLS_SCRIPT_URL;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load HLS.js'));
    document.head.appendChild(script);
  });
}

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
  const container = document.getElementById('camerasContent');
  if (!container) return;

  if (!cameras.length) {
    container.innerHTML = '<div class="m-loading-inline">No cameras configured.</div>';
    return;
  }

  container.innerHTML = `<div class="m-cam-grid">
    ${cameras.map((cam, i) => renderCameraCard(cam, i)).join('')}
  </div>`;

  bindEvents();

  // Start all streams
  cameras.forEach((cam, i) => {
    const defaultQuality = cam.streams.med ? 'med' : cam.streams.low ? 'low' : 'high';
    currentQualities[i] = defaultQuality;
    startStream(i, defaultQuality);
  });
}

function renderCameraCard(cam, index) {
  const hasLow = !!cam.streams.low;
  const hasMed = !!cam.streams.med;
  const hasHigh = !!cam.streams.high;

  return `
    <div class="m-cam-card" data-cam="${index}">
      <div class="m-cam-card__header">
        <span class="m-cam-card__name">
          <span class="m-dot m-dot--gray" id="cam-dot-${index}"></span>
          ${esc(cam.name)}
        </span>
        <div class="m-cam-card__quality">
          <select data-action="quality" data-cam="${index}">
            ${hasLow ? '<option value="low">Low</option>' : ''}
            ${hasMed ? '<option value="med" selected>Med</option>' : ''}
            ${hasHigh ? '<option value="high">High</option>' : ''}
          </select>
        </div>
      </div>
      <div class="m-cam-card__video">
        <video id="cam-video-${index}" muted autoplay playsinline></video>
        <div class="m-cam-overlay" id="cam-overlay-${index}">Connecting...</div>
      </div>
    </div>
  `;
}

// =============================================
// HLS STREAMING
// =============================================
function startStream(camIndex, quality) {
  // Destroy existing instance
  destroyStream(camIndex);

  const cam = cameras[camIndex];
  const stream = cam.streams[quality];
  if (!stream) return;

  const videoEl = document.getElementById(`cam-video-${camIndex}`);
  const overlay = document.getElementById(`cam-overlay-${camIndex}`);
  const dot = document.getElementById(`cam-dot-${camIndex}`);

  if (!videoEl) return;

  const hlsUrl = buildHlsUrl(stream);

  // Check for native HLS support (Safari / iOS)
  if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = hlsUrl;
    videoEl.addEventListener('loadeddata', () => {
      overlay?.classList.add('hidden');
      if (dot) { dot.className = 'm-dot m-dot--green m-dot--pulse'; }
    }, { once: true });
    videoEl.addEventListener('error', () => {
      handleStreamError(camIndex);
    }, { once: true });
    return;
  }

  // Use HLS.js
  if (typeof Hls === 'undefined' || !Hls.isSupported()) {
    if (overlay) overlay.textContent = 'HLS not supported';
    return;
  }

  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: true,
    maxBufferLength: 10,
    maxMaxBufferLength: 20,
    liveSyncDurationCount: 2,
    liveMaxLatencyDurationCount: 4,
    fragLoadingMaxRetry: 3,
    manifestLoadingMaxRetry: 3,
  });

  hls.loadSource(hlsUrl);
  hls.attachMedia(videoEl);

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    videoEl.play().catch(() => {});
    overlay?.classList.add('hidden');
    if (dot) { dot.className = 'm-dot m-dot--green m-dot--pulse'; }
    retryCounts[camIndex] = 0;
  });

  hls.on(Hls.Events.ERROR, (event, data) => {
    if (data.fatal) {
      console.warn(`Camera ${camIndex} HLS fatal error:`, data.type);
      handleStreamError(camIndex);
    }
  });

  hlsInstances[camIndex] = hls;
}

function destroyStream(camIndex) {
  if (hlsInstances[camIndex]) {
    hlsInstances[camIndex].destroy();
    delete hlsInstances[camIndex];
  }
  clearTimeout(retryTimers[camIndex]);
}

function handleStreamError(camIndex) {
  const overlay = document.getElementById(`cam-overlay-${camIndex}`);
  const dot = document.getElementById(`cam-dot-${camIndex}`);

  if (dot) { dot.className = 'm-dot m-dot--red'; }

  retryCounts[camIndex] = (retryCounts[camIndex] || 0) + 1;

  if (retryCounts[camIndex] <= MAX_RETRIES) {
    if (overlay) {
      overlay.textContent = `Reconnecting (${retryCounts[camIndex]}/${MAX_RETRIES})...`;
      overlay.classList.remove('hidden');
    }
    retryTimers[camIndex] = setTimeout(() => {
      startStream(camIndex, currentQualities[camIndex] || 'med');
    }, RETRY_DELAY_MS);
  } else {
    if (overlay) {
      overlay.textContent = 'Stream unavailable. Tap to retry.';
      overlay.classList.remove('hidden');
      overlay.style.cursor = 'pointer';
      overlay.onclick = () => {
        retryCounts[camIndex] = 0;
        overlay.textContent = 'Connecting...';
        overlay.style.cursor = '';
        overlay.onclick = null;
        startStream(camIndex, currentQualities[camIndex] || 'med');
      };
    }
  }
}

// =============================================
// EVENTS
// =============================================
function bindEvents() {
  const container = document.getElementById('camerasContent');
  if (!container) return;

  // Quality selection
  container.querySelectorAll('[data-action="quality"]').forEach(select => {
    select.addEventListener('change', (e) => {
      const camIndex = parseInt(e.target.dataset.cam);
      const quality = e.target.value;
      currentQualities[camIndex] = quality;
      retryCounts[camIndex] = 0;
      startStream(camIndex, quality);
    });
  });
}

// =============================================
// VISIBILITY HANDLING
// =============================================
function setupVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Pause all streams when app goes background
      cameras.forEach((_, i) => destroyStream(i));
    } else {
      // Resume streams
      cameras.forEach((_, i) => {
        retryCounts[i] = 0;
        startStream(i, currentQualities[i] || 'med');
      });
    }
  });
}

// =============================================
// INIT
// =============================================
export async function init(user) {
  try {
    await loadHlsScript();
    cameras = await loadCameras();
    render();
    setupVisibility();
  } catch (err) {
    console.error('Cameras tab init failed:', err);
    const container = document.getElementById('camerasContent');
    if (container) {
      container.innerHTML = '<div class="m-error">Failed to load cameras.</div>';
    }
  }
}
