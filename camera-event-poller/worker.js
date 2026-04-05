/**
 * Camera Event Poller
 * Polls UniFi Protect Events API every 10s for smart detections
 * (person, animal, vehicle, package). Logs events with thumbnails
 * to camera_events table, sends SMS via configurable rules.
 *
 * Auth: Cookie + CSRF token to UDM Pro (same as ptz-proxy)
 * Storage: Thumbnails uploaded to Supabase Storage (housephotos/camera-events/)
 * SMS: Via send-sms edge function (Telnyx)
 *
 * Deploy to: /opt/camera-event-poller/ on DO droplet
 * Systemd: camera-event-poller.service
 */

import { createClient } from '@supabase/supabase-js';
import https from 'https';

// ============================================
// Configuration
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UDM_HOST = process.env.UDM_HOST || '192.168.1.1';
const UDM_USER = process.env.UDM_USER || 'propertyauto';
const UDM_PASS = process.env.UDM_PASS || '';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000'); // 10s
const STORAGE_BUCKET = 'housephotos';
const STORAGE_PREFIX = 'camera-events';

// Known camera names (fallback if API doesn't return them)
const CAMERA_NAMES = {
  '694c550400317503e400044b': 'Propertymera',
  '696534fc003eed03e4028eee': 'Front Of House',
  '696537cc0067ed03e402929c': 'Side Yard',
};

if (!SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');
  process.exit(1);
}

if (!UDM_PASS) {
  console.error('UDM_PASS environment variable is required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================
// Logging
// ============================================
function log(level, msg, data = {}) {
  const ts = new Date().toISOString();
  const dataStr = Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${ts}] [${level}] ${msg}${dataStr}`);
}

// ============================================
// UniFi Protect Auth (cookie + CSRF from JWT)
// ============================================
let sessionCookie = null;
let csrfToken = null;
let authExpiry = 0;

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ rejectUnauthorized: false });
    options.agent = agent;

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: data,
        setCookie: res.headers['set-cookie'],
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsRequestBinary(options) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ rejectUnauthorized: false });
    options.agent = agent;

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function authenticate() {
  log('info', 'Authenticating to UniFi Protect...');

  const authBody = JSON.stringify({ username: UDM_USER, password: UDM_PASS });

  const res = await httpsRequest({
    hostname: UDM_HOST,
    port: 443,
    path: '/api/auth/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(authBody),
    },
  }, authBody);

  if (res.status !== 200) {
    throw new Error(`Auth failed: ${res.status} ${res.body.substring(0, 200)}`);
  }

  const cookies = res.setCookie || [];
  const tokenCookie = cookies.find(c => c.startsWith('TOKEN='));
  if (!tokenCookie) {
    throw new Error('No TOKEN cookie in auth response');
  }

  sessionCookie = tokenCookie.split(';')[0];

  // Extract CSRF from JWT payload
  const jwt = sessionCookie.replace('TOKEN=', '');
  const payloadB64 = jwt.split('.')[1];
  const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
  const payload = JSON.parse(Buffer.from(padded, 'base64').toString());
  csrfToken = payload.csrfToken;

  // Sessions last ~24h, refresh every 12h
  authExpiry = Date.now() + 12 * 60 * 60 * 1000;

  log('info', 'Auth success', { csrf: csrfToken.substring(0, 12) + '...' });
}

async function ensureAuth() {
  if (!sessionCookie || !csrfToken || Date.now() > authExpiry) {
    await authenticate();
  }
}

// Retry on 401
async function withAuthRetry(fn) {
  let result = await fn();
  if (result.status === 401) {
    log('warn', 'Got 401, re-authenticating...');
    sessionCookie = null;
    await ensureAuth();
    result = await fn();
  }
  return result;
}

// ============================================
// UniFi Protect API calls
// ============================================
async function fetchEvents(startMs, endMs) {
  await ensureAuth();

  const path = `/proxy/protect/api/events?start=${startMs}&end=${endMs}&types=smartDetectZone`;

  return withAuthRetry(() => httpsRequest({
    hostname: UDM_HOST,
    port: 443,
    path,
    method: 'GET',
    headers: {
      'Cookie': sessionCookie,
      'X-CSRF-Token': csrfToken,
    },
  }));
}

async function fetchThumbnail(eventId) {
  await ensureAuth();

  return withAuthRetry(() => httpsRequestBinary({
    hostname: UDM_HOST,
    port: 443,
    path: `/proxy/protect/api/thumbnails/e-${eventId}`,
    method: 'GET',
    headers: {
      'Cookie': sessionCookie,
      'X-CSRF-Token': csrfToken,
    },
  }));
}

// ============================================
// Supabase Storage upload
// ============================================
async function uploadThumbnail(eventId, buffer) {
  const storagePath = `${STORAGE_PREFIX}/${eventId}.jpg`;

  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: 'image/jpeg',
      upsert: false,
    });

  if (error) {
    // If already exists, just return the URL
    if (error.message?.includes('already exists') || error.statusCode === '409') {
      log('warn', 'Thumbnail already uploaded, using existing', { eventId });
    } else {
      throw new Error(`Storage upload failed: ${error.message}`);
    }
  }

  const { data: urlData } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(storagePath);

  return urlData.publicUrl;
}

// ============================================
// SMS via send-sms edge function
// ============================================
async function sendSms(phone, message) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'apikey': SUPABASE_SERVICE_KEY,
    },
    body: JSON.stringify({
      type: 'general',
      to: phone,
      data: { message },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SMS failed ${res.status}: ${text.substring(0, 200)}`);
  }

  return await res.json();
}

// ============================================
// Rule matching + cooldown check
// ============================================
async function loadRules() {
  const { data, error } = await supabase
    .from('camera_event_rules')
    .select('*')
    .eq('is_active', true);

  if (error) {
    log('error', 'Failed to load rules', { error: error.message });
    return [];
  }

  return data || [];
}

function matchRules(rules, cameraId, smartDetectTypes, score) {
  return rules.filter(rule => {
    // Camera match: null = all cameras
    if (rule.camera_id && rule.camera_id !== cameraId) return false;

    // Detection type match: '*' = all types
    if (rule.detection_type !== '*') {
      if (!smartDetectTypes.includes(rule.detection_type)) return false;
    }

    // Minimum score
    if (score < rule.min_score) return false;

    // Time window check (optional)
    if (rule.time_start && rule.time_end) {
      const now = new Date();
      const hours = now.getHours();
      const mins = now.getMinutes();
      const currentTime = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;

      if (rule.time_start <= rule.time_end) {
        // Normal window: e.g. 08:00 to 22:00
        if (currentTime < rule.time_start || currentTime > rule.time_end) return false;
      } else {
        // Overnight window: e.g. 22:00 to 06:00
        if (currentTime < rule.time_start && currentTime > rule.time_end) return false;
      }
    }

    return true;
  });
}

async function checkCooldown(rule, cameraId, detectionType) {
  const cooldownMs = (rule.cooldown_seconds || 300) * 1000;
  const since = new Date(Date.now() - cooldownMs).toISOString();

  const { data, error } = await supabase
    .from('camera_events')
    .select('id')
    .eq('camera_id', cameraId)
    .contains('smart_detect_types', [detectionType])
    .gte('created_at', since)
    .not('actions_taken', 'is', null)
    .limit(1);

  if (error) {
    log('error', 'Cooldown check failed', { error: error.message });
    return false; // On error, allow action (fail open)
  }

  // If we found a recent actioned event, cooldown is active
  return data && data.length > 0;
}

// ============================================
// Process a single event
// ============================================
async function processEvent(event, rules) {
  const eventId = event.id;
  const cameraId = event.camera;
  const cameraName = CAMERA_NAMES[cameraId] || event.cameraName || cameraId;
  const smartDetectTypes = event.smartDetectTypes || [];
  const score = event.score || 0;
  const eventStart = event.start ? new Date(event.start).toISOString() : null;
  const eventEnd = event.end ? new Date(event.end).toISOString() : null;

  log('info', 'Processing event', {
    eventId: eventId.substring(0, 16),
    camera: cameraName,
    types: smartDetectTypes,
    score,
  });

  // Check if already processed (dedup layer 1: pre-insert check)
  const { data: existing } = await supabase
    .from('camera_events')
    .select('id')
    .eq('protect_event_id', eventId)
    .limit(1);

  if (existing && existing.length > 0) {
    log('debug', 'Event already processed, skipping', { eventId: eventId.substring(0, 16) });
    return;
  }

  // Fetch thumbnail
  let thumbnailUrl = null;
  try {
    const thumbRes = await fetchThumbnail(eventId);
    if (thumbRes.status === 200 && thumbRes.body.length > 0) {
      thumbnailUrl = await uploadThumbnail(eventId, thumbRes.body);
      log('info', 'Thumbnail uploaded', {
        eventId: eventId.substring(0, 16),
        size: `${(thumbRes.body.length / 1024).toFixed(0)}KB`,
      });
    } else {
      log('warn', 'No thumbnail available', { eventId: eventId.substring(0, 16), status: thumbRes.status });
    }
  } catch (err) {
    log('warn', 'Thumbnail fetch/upload failed', {
      eventId: eventId.substring(0, 16),
      error: err.message,
    });
  }

  // Match rules
  const matchedRules = matchRules(rules, cameraId, smartDetectTypes, score);
  const actionsTaken = [];

  for (const rule of matchedRules) {
    const primaryType = smartDetectTypes[0] || 'unknown';

    // Check cooldown per detection type
    const onCooldown = await checkCooldown(rule, cameraId, primaryType);
    if (onCooldown) {
      log('info', 'Rule on cooldown, skipping action', {
        rule: rule.name,
        camera: cameraName,
        type: primaryType,
        cooldown: `${rule.cooldown_seconds}s`,
      });
      actionsTaken.push({
        rule_id: rule.id,
        rule_name: rule.name,
        action: 'skipped_cooldown',
      });
      continue;
    }

    // Execute action
    if (rule.action_type === 'sms') {
      const config = rule.action_config || {};
      const phone = config.phone;
      const template = config.message_template || '{type} detected on {camera} at {time}';

      if (!phone) {
        log('warn', 'SMS rule has no phone number', { rule: rule.name });
        continue;
      }

      // Format message from template
      const now = new Date();
      const timeStr = now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/Chicago',
      });
      const message = template
        .replace('{type}', primaryType.charAt(0).toUpperCase() + primaryType.slice(1))
        .replace('{camera}', cameraName)
        .replace('{time}', timeStr)
        .replace('{score}', String(score));

      try {
        await sendSms(phone, message);
        log('info', 'SMS sent', { rule: rule.name, phone, message });
        actionsTaken.push({
          rule_id: rule.id,
          rule_name: rule.name,
          action: 'sms',
          phone,
          message,
          sent_at: new Date().toISOString(),
        });
      } catch (err) {
        log('error', 'SMS send failed', { rule: rule.name, error: err.message });
        actionsTaken.push({
          rule_id: rule.id,
          rule_name: rule.name,
          action: 'sms_failed',
          error: err.message,
        });
      }
    }
  }

  // Insert event record (dedup layer 2: UNIQUE constraint fallback)
  const { error: insertErr } = await supabase
    .from('camera_events')
    .insert({
      protect_event_id: eventId,
      camera_id: cameraId,
      camera_name: cameraName,
      event_type: 'smartDetectZone',
      smart_detect_types: smartDetectTypes,
      score,
      thumbnail_url: thumbnailUrl,
      event_start: eventStart,
      event_end: eventEnd,
      metadata: {
        modelKey: event.modelKey,
        type: event.type,
        smartDetectEvents: event.smartDetectEvents,
      },
      actions_taken: actionsTaken.length > 0 ? actionsTaken : null,
    });

  if (insertErr) {
    if (insertErr.code === '23505') {
      // Unique violation — already inserted (race condition handled)
      log('debug', 'Event already inserted (unique violation)', { eventId: eventId.substring(0, 16) });
    } else {
      log('error', 'Event insert failed', { eventId: eventId.substring(0, 16), error: insertErr.message });
    }
    return;
  }

  const actionSummary = actionsTaken.filter(a => a.action === 'sms').length;
  log('info', 'Event recorded', {
    eventId: eventId.substring(0, 16),
    camera: cameraName,
    types: smartDetectTypes,
    score,
    smsSent: actionSummary,
    thumbnail: !!thumbnailUrl,
  });
}

// ============================================
// Poll cycle
// ============================================
let lastPollEnd = Date.now() - 30000; // Start 30s in the past on first poll
let isProcessing = false;

async function pollCycle() {
  if (isProcessing) {
    log('warn', 'Previous poll still running, skipping');
    return;
  }

  isProcessing = true;

  try {
    const now = Date.now();
    const startMs = lastPollEnd;
    const endMs = now;

    // Fetch events from Protect API
    const res = await fetchEvents(startMs, endMs);

    if (res.status !== 200) {
      log('error', 'Events fetch failed', { status: res.status, body: res.body.substring(0, 200) });
      return;
    }

    let events;
    try {
      events = JSON.parse(res.body);
    } catch {
      log('error', 'Invalid JSON from events API', { body: res.body.substring(0, 200) });
      return;
    }

    if (!Array.isArray(events)) {
      log('error', 'Events response is not an array', { type: typeof events });
      return;
    }

    // Update poll window BEFORE processing to avoid re-fetching on error
    lastPollEnd = endMs;

    if (events.length === 0) {
      return; // Silent — no events is normal
    }

    log('info', `Found ${events.length} event(s)`, {
      window: `${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`,
    });

    // Load rules once per poll cycle
    const rules = await loadRules();

    // Process each event
    for (const event of events) {
      try {
        await processEvent(event, rules);
      } catch (err) {
        log('error', 'Event processing failed', {
          eventId: event.id?.substring(0, 16),
          error: err.message,
        });
      }
    }
  } catch (err) {
    log('error', 'Poll cycle error', { error: err.message, stack: err.stack?.substring(0, 300) });
  } finally {
    isProcessing = false;
  }
}

// ============================================
// Main
// ============================================
async function main() {
  log('info', '=== Camera Event Poller starting ===');
  log('info', 'Configuration', {
    udmHost: UDM_HOST,
    pollInterval: `${POLL_INTERVAL_MS / 1000}s`,
    cameras: Object.keys(CAMERA_NAMES).length,
  });

  // Pre-authenticate on startup
  try {
    await authenticate();
    log('info', 'Startup auth successful');
  } catch (err) {
    log('error', 'Startup auth failed', { error: err.message });
    log('info', 'Will retry on first poll...');
  }

  // Run first poll immediately
  await pollCycle();

  // Then poll on interval
  setInterval(pollCycle, POLL_INTERVAL_MS);

  log('info', `Polling every ${POLL_INTERVAL_MS / 1000}s`);
}

main().catch(err => {
  log('error', 'Fatal error', { error: err.message });
  process.exit(1);
});
