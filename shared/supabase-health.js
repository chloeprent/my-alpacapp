/**
 * Supabase Health Monitor
 *
 * Tracks Supabase connectivity, shows a status banner on degradation/outage,
 * and provides hooks for PollManager circuit breaking.
 *
 * Usage:
 *   import { supabaseHealth } from './supabase-health.js';
 *   supabaseHealth.recordSuccess();   // after a successful query
 *   supabaseHealth.recordFailure();   // after a failed query
 *   supabaseHealth.injectBanner();    // show banner (call once per page)
 */

import { pingSupabase } from './supabase.js';

// =============================================
// CONFIGURATION
// =============================================

const DEGRADED_THRESHOLD = 3;   // consecutive failures before 'degraded'
const DOWN_THRESHOLD = 6;       // consecutive failures before 'down'
const PROBE_INTERVAL_MS = 30000; // recovery probe interval when down
const QUERY_TIMEOUT_MS = 15000;  // timeout for withHealthCheck wrapper

// =============================================
// STATE
// =============================================

let status = 'healthy';         // 'healthy' | 'degraded' | 'down'
let consecutiveFailures = 0;
let lastSuccessAt = Date.now();
let isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
let listeners = [];
let probeTimer = null;
let bannerEl = null;
let dismissed = false;          // user dismissed the banner for current status

// =============================================
// STATUS MANAGEMENT
// =============================================

function setStatus(newStatus) {
  if (newStatus === status) return;
  const prev = status;
  status = newStatus;
  dismissed = false; // reset dismiss on status change
  console.log(`[supabase-health] ${prev} → ${newStatus} (failures: ${consecutiveFailures})`);
  updateBanner();
  listeners.forEach(cb => {
    try { cb(newStatus, prev); } catch (e) { console.warn('[supabase-health] listener error:', e); }
  });

  // Start/stop recovery probes
  if (newStatus === 'down' || newStatus === 'degraded') {
    startProbe();
  } else {
    stopProbe();
  }
}

function recordSuccess() {
  consecutiveFailures = 0;
  lastSuccessAt = Date.now();
  if (status !== 'healthy') {
    setStatus('healthy');
  }
}

function recordFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= DOWN_THRESHOLD && status !== 'down') {
    setStatus('down');
  } else if (consecutiveFailures >= DEGRADED_THRESHOLD && status === 'healthy') {
    setStatus('degraded');
  }
}

function getStatus() {
  return { status, consecutiveFailures, lastSuccessAt, isOnline };
}

function isHealthy() {
  return status === 'healthy' && isOnline;
}

function onStatusChange(cb) {
  listeners.push(cb);
  return () => { listeners = listeners.filter(l => l !== cb); };
}

// =============================================
// RECOVERY PROBE
// =============================================

function startProbe() {
  if (probeTimer) return;
  probeTimer = setInterval(async () => {
    if (!isOnline) return; // don't probe when browser is offline
    try {
      const ok = await pingSupabase();
      if (ok) {
        console.log('[supabase-health] Recovery probe succeeded');
        recordSuccess();
      }
    } catch {
      // probe failed, stay in current state
    }
  }, PROBE_INTERVAL_MS);
}

function stopProbe() {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

// =============================================
// ONLINE / OFFLINE
// =============================================

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    isOnline = true;
    console.log('[supabase-health] Browser online');
    // Trigger immediate probe to check if Supabase is reachable
    if (status !== 'healthy') {
      pingSupabase().then(ok => { if (ok) recordSuccess(); }).catch(() => {});
    }
    updateBanner();
  });

  window.addEventListener('offline', () => {
    isOnline = false;
    console.log('[supabase-health] Browser offline');
    updateBanner();
  });
}

// =============================================
// BANNER
// =============================================

const BANNER_HTML = `
<div class="supabase-health-banner" id="supabaseHealthBanner" role="alert" aria-live="polite" style="display:none">
  <span class="supabase-health-banner__icon">
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
  </span>
  <span class="supabase-health-banner__message"></span>
  <button class="supabase-health-banner__dismiss" aria-label="Dismiss">&times;</button>
</div>`;

const MESSAGES = {
  degraded: 'Having trouble connecting. Some features may be unavailable.',
  down: 'Unable to reach the server. Showing cached data where possible.',
  offline: 'You appear to be offline. Check your internet connection.',
};

function injectBanner() {
  if (bannerEl) return; // already injected

  // Inject CSS (avoids needing a <link> in every HTML page)
  if (!document.getElementById('supabaseHealthCSS')) {
    const link = document.createElement('link');
    link.id = 'supabaseHealthCSS';
    link.rel = 'stylesheet';
    link.href = '/shared/supabase-health.css';
    document.head.appendChild(link);
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = BANNER_HTML.trim();
  bannerEl = wrapper.firstChild;
  document.body.prepend(bannerEl);

  bannerEl.querySelector('.supabase-health-banner__dismiss').addEventListener('click', () => {
    dismissed = true;
    bannerEl.classList.remove('visible');
  });

  updateBanner();
}

function updateBanner() {
  if (!bannerEl) return;

  const effectiveStatus = !isOnline ? 'offline' : status;

  if (effectiveStatus === 'healthy' || dismissed) {
    bannerEl.style.display = 'none';
    bannerEl.classList.remove('visible', 'degraded', 'down', 'offline');
    return;
  }

  const msg = MESSAGES[effectiveStatus] || MESSAGES.down;
  bannerEl.querySelector('.supabase-health-banner__message').textContent = msg;
  bannerEl.classList.remove('degraded', 'down', 'offline');
  bannerEl.classList.add(effectiveStatus, 'visible');
  bannerEl.style.display = 'flex';
}

// =============================================
// QUERY WRAPPER
// =============================================

/**
 * Wrap an async function with timeout + health tracking.
 * Returns { data, error } — same shape as Supabase queries.
 *
 * Example:
 *   const { data, error } = await supabaseHealth.withHealthCheck(
 *     () => supabase.from('spaces').select('*')
 *   );
 */
async function withHealthCheck(queryFn, timeoutMs = QUERY_TIMEOUT_MS) {
  try {
    const result = await Promise.race([
      queryFn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Query timed out')), timeoutMs)
      ),
    ]);

    // Handle Supabase-style {data, error} results
    if (result && typeof result === 'object' && 'error' in result) {
      if (result.error) {
        recordFailure();
      } else {
        recordSuccess();
      }
      return result;
    }

    // Non-Supabase result (fetch response, etc.)
    recordSuccess();
    return { data: result, error: null };
  } catch (err) {
    recordFailure();
    return { data: null, error: err };
  }
}

// =============================================
// EXPORTS
// =============================================

/**
 * Test helper — force a specific banner state from the browser console.
 * Usage:  supabaseHealth.simulate('degraded')   // amber banner
 *         supabaseHealth.simulate('down')        // red banner
 *         supabaseHealth.simulate('offline')     // dark banner
 *         supabaseHealth.simulate('healthy')     // hide banner
 */
function simulateStatus(newStatus) {
  if (newStatus === 'offline') {
    isOnline = false;
    updateBanner();
    console.log('[supabase-health] Simulating offline — call simulate("healthy") to reset');
    return;
  }
  isOnline = true;
  if (newStatus === 'healthy') {
    consecutiveFailures = 0;
    status = 'healthy';
    dismissed = false;
    stopProbe();
    updateBanner();
    listeners.forEach(cb => { try { cb('healthy', status); } catch (e) {} });
    console.log('[supabase-health] Reset to healthy');
    return;
  }
  // Force status without going through failure counting
  const prev = status;
  status = newStatus;
  dismissed = false;
  consecutiveFailures = newStatus === 'down' ? DOWN_THRESHOLD : DEGRADED_THRESHOLD;
  updateBanner();
  listeners.forEach(cb => { try { cb(newStatus, prev); } catch (e) {} });
  console.log(`[supabase-health] Simulating ${newStatus} — call simulate("healthy") to reset`);
}

export const supabaseHealth = {
  recordSuccess,
  recordFailure,
  getStatus,
  isHealthy,
  onStatusChange,
  injectBanner,
  withHealthCheck,
  simulate: simulateStatus,

  // Constants for PollManager integration
  DEGRADED_THRESHOLD,
  DOWN_THRESHOLD,
};

// Expose on window for console testing
if (typeof window !== 'undefined') {
  window.supabaseHealth = supabaseHealth;
}
