/**
 * Blink Camera Snapshot Poller
 * Authenticates to Blink cloud API (OAuth), periodically fetches camera thumbnails,
 * and uploads them to Supabase Storage for display on the cameras page.
 *
 * Deploy to: /opt/blink-poller/ on DO droplet
 * Systemd: blink-poller.service
 *
 * Environment variables:
 *   SUPABASE_URL              - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Service role key for storage uploads
 *   BLINK_EMAIL               - Blink account email
 *   BLINK_PASSWORD            - Blink account password
 *   POLL_INTERVAL_MS          - Snapshot poll interval (default: 60000 = 60s)
 *
 * First-run 2FA:
 *   Run interactively: node worker.js --setup
 *   Enter the PIN sent to your email/phone when prompted.
 *   Credentials are saved to .blink-cred.json for future sessions.
 */

import { createClient } from '@supabase/supabase-js';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createInterface } from 'readline';

// ============================================
// Configuration
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BLINK_EMAIL = process.env.BLINK_EMAIL;
const BLINK_PASSWORD = process.env.BLINK_PASSWORD;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000');
const CRED_FILE = '.blink-cred.json';
const STORAGE_BUCKET = 'housephotos';
const SNAPSHOT_PATH = 'cameras/blink-latest.jpg';

// Blink API constants (matching blinkpy)
const OAUTH_TOKEN_URL = 'https://api.oauth.blink.com/oauth/token';
const TIER_URL = 'https://rest-prod.immedia-semi.com/api/v1/users/tier_info';
const BLINK_URL_SUFFIX = 'immedia-semi.com';
const APP_BUILD = 'ANDROID_28373244';
const DEFAULT_USER_AGENT = `27.0${APP_BUILD}`;
const OAUTH_CLIENT_ID = 'android';
const OAUTH_SCOPE = 'client';

if (!SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');
  process.exit(1);
}
if (!BLINK_EMAIL || !BLINK_PASSWORD) {
  console.error('BLINK_EMAIL and BLINK_PASSWORD environment variables are required');
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
// Blink OAuth Client
// ============================================
let blinkAuth = null;  // { accessToken, refreshToken, expiresAt, accountId, regionBase, hardwareId }
let blinkCameras = []; // [{ id, name, networkId, thumbnail }]

async function loadSavedCreds() {
  if (!existsSync(CRED_FILE)) return null;
  try {
    const data = JSON.parse(await readFile(CRED_FILE, 'utf-8'));
    log('INFO', 'Loaded saved credentials');
    return data;
  } catch {
    return null;
  }
}

async function saveCreds() {
  if (!blinkAuth) return;
  await writeFile(CRED_FILE, JSON.stringify({
    accessToken: blinkAuth.accessToken,
    refreshToken: blinkAuth.refreshToken,
    expiresAt: blinkAuth.expiresAt,
    accountId: blinkAuth.accountId,
    regionBase: blinkAuth.regionBase,
    hardwareId: blinkAuth.hardwareId,
  }, null, 2));
}

/**
 * OAuth password grant login
 * POST https://api.oauth.blink.com/oauth/token
 * Content-Type: application/x-www-form-urlencoded
 */
async function oauthLogin(twoFaCode = null) {
  log('INFO', 'Authenticating to Blink API via OAuth...');

  const hardwareId = blinkAuth?.hardwareId || `Blinkpy_${Date.now()}`;

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': DEFAULT_USER_AGENT,
    'hardware_id': hardwareId,
  };

  if (twoFaCode) {
    headers['2fa-code'] = twoFaCode;
  }

  const body = new URLSearchParams({
    username: BLINK_EMAIL,
    password: BLINK_PASSWORD,
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPE,
    grant_type: 'password',
  });

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  if (resp.status === 412) {
    log('WARN', '2FA required! Run with --setup to complete verification.');
    throw new Error('2FA_REQUIRED');
  }

  if (resp.status === 401) {
    const text = await resp.text();
    log('ERROR', `Auth failed (401): ${text.substring(0, 200)}`);
    throw new Error('Invalid credentials');
  }

  if (!resp.ok) {
    const text = await resp.text();
    log('ERROR', `OAuth login failed (${resp.status}): ${text.substring(0, 300)}`);
    throw new Error(`Login failed: ${resp.status}`);
  }

  const data = await resp.json();
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn = data.expires_in || 3600;

  if (!accessToken) {
    log('ERROR', 'No access_token in OAuth response', data);
    throw new Error('Missing access_token');
  }

  blinkAuth = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (expiresIn * 1000),
    hardwareId,
    accountId: null,
    regionBase: null,
  };

  log('INFO', `OAuth login success. Token expires in ${expiresIn}s`);

  // Get tier info for account_id and region
  await fetchTierInfo();
  await saveCreds();
}

/**
 * Refresh token if available
 */
async function oauthRefresh() {
  if (!blinkAuth?.refreshToken) {
    throw new Error('No refresh token');
  }

  log('INFO', 'Refreshing Blink OAuth token...');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: blinkAuth.refreshToken,
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPE,
  });

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': DEFAULT_USER_AGENT,
      'hardware_id': blinkAuth.hardwareId,
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    log('WARN', `Token refresh failed (${resp.status}), will re-login`);
    throw new Error('Refresh failed');
  }

  const data = await resp.json();
  blinkAuth.accessToken = data.access_token;
  blinkAuth.refreshToken = data.refresh_token || blinkAuth.refreshToken;
  blinkAuth.expiresAt = Date.now() + ((data.expires_in || 3600) * 1000);

  log('INFO', 'Token refresh successful');
  await saveCreds();
}

/**
 * GET /api/v1/users/tier_info to get account_id and region
 */
async function fetchTierInfo() {
  const resp = await fetch(TIER_URL, {
    headers: {
      'Authorization': `Bearer ${blinkAuth.accessToken}`,
      'User-Agent': DEFAULT_USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    log('WARN', `Tier info failed (${resp.status}): ${text.substring(0, 200)}`);
    // Fall back to default
    blinkAuth.regionBase = `https://rest-prod.${BLINK_URL_SUFFIX}`;
    return;
  }

  const data = await resp.json();
  const tier = data.tier;
  blinkAuth.accountId = data.account_id;
  blinkAuth.regionBase = tier
    ? `https://rest-${tier}.${BLINK_URL_SUFFIX}`
    : `https://rest-prod.${BLINK_URL_SUFFIX}`;

  log('INFO', `Tier info: account=${blinkAuth.accountId}, region=${tier}`, { regionBase: blinkAuth.regionBase });
}

/**
 * Ensure we have a valid auth token (refresh if needed)
 */
async function ensureAuth() {
  if (!blinkAuth?.accessToken) {
    // Try loading saved creds
    const saved = await loadSavedCreds();
    if (saved?.accessToken) {
      blinkAuth = saved;
    }
  }

  // Check if token is expired or about to expire (60s buffer)
  if (blinkAuth?.accessToken && blinkAuth.expiresAt && blinkAuth.expiresAt - Date.now() > 60000) {
    return; // Token still valid
  }

  // Try refresh first
  if (blinkAuth?.refreshToken) {
    try {
      await oauthRefresh();
      return;
    } catch {
      log('WARN', 'Refresh failed, falling back to login');
    }
  }

  // Full login
  await oauthLogin();
}

/**
 * Make authenticated Blink API request
 */
async function blinkApiRequest(path, method = 'GET', body = null) {
  await ensureAuth();

  const url = path.startsWith('http') ? path : `${blinkAuth.regionBase}${path}`;
  const headers = {
    'Authorization': `Bearer ${blinkAuth.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': DEFAULT_USER_AGENT,
  };

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);

  // Re-auth on 401
  if (resp.status === 401) {
    log('WARN', 'Got 401, refreshing auth...');
    try {
      await oauthRefresh();
    } catch {
      await oauthLogin();
    }
    // Retry once
    headers['Authorization'] = `Bearer ${blinkAuth.accessToken}`;
    return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  }

  return resp;
}

// ============================================
// Camera Discovery & Thumbnail Fetching
// ============================================

async function discoverCameras() {
  const resp = await blinkApiRequest(
    `/api/v3/accounts/${blinkAuth.accountId}/homescreen`
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Homescreen fetch failed: ${resp.status} ${text.substring(0, 200)}`);
  }

  const homescreen = await resp.json();
  blinkCameras = [];

  const cameras = homescreen.cameras || [];
  for (const cam of cameras) {
    blinkCameras.push({
      id: cam.id,
      name: cam.name,
      networkId: cam.network_id,
      thumbnail: cam.thumbnail,
      status: cam.status,
    });
  }

  log('INFO', `Discovered ${blinkCameras.length} Blink camera(s)`, {
    cameras: blinkCameras.map(c => `${c.name} (${c.status})`),
  });
}

async function fetchThumbnailJpeg(cam) {
  if (!cam.thumbnail) {
    log('WARN', `No thumbnail URL for ${cam.name}`);
    return null;
  }

  // Thumbnail path from homescreen (relative), append .jpg
  const thumbPath = cam.thumbnail.startsWith('/') ? cam.thumbnail : `/${cam.thumbnail}`;
  const resp = await blinkApiRequest(`${thumbPath}.jpg`);

  if (!resp.ok) {
    // Try without .jpg extension
    const resp2 = await blinkApiRequest(thumbPath);
    if (!resp2.ok) {
      log('WARN', `Thumbnail fetch failed for ${cam.name}: ${resp.status}`);
      return null;
    }
    const buffer = await resp2.arrayBuffer();
    return new Uint8Array(buffer);
  }

  const buffer = await resp.arrayBuffer();
  return new Uint8Array(buffer);
}

async function requestNewThumbnail(cam) {
  try {
    const resp = await blinkApiRequest(
      `/network/${cam.networkId}/camera/${cam.id}/thumbnail`,
      'POST'
    );
    if (resp.ok) {
      log('INFO', `Requested new thumbnail for ${cam.name}`);
    } else {
      log('WARN', `Thumbnail request failed for ${cam.name}: ${resp.status}`);
    }
  } catch (err) {
    log('WARN', `Thumbnail request error for ${cam.name}: ${err.message}`);
  }
}

// ============================================
// Supabase Storage Upload
// ============================================
async function uploadSnapshot(jpegData, filename = SNAPSHOT_PATH) {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(filename, jpegData, {
      contentType: 'image/jpeg',
      upsert: true,
      cacheControl: '30',
    });

  if (error) {
    log('ERROR', `Storage upload failed: ${error.message}`);
    return null;
  }

  const { data: urlData } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(filename);

  return urlData?.publicUrl;
}

// ============================================
// 2FA Setup Flow
// ============================================
async function setup2FA() {
  log('INFO', '=== Blink 2FA Setup Mode ===');

  // Step 1: Try login (will fail with 2FA required)
  try {
    await oauthLogin();
    log('INFO', 'Login succeeded without 2FA! Credentials saved.');
    return;
  } catch (err) {
    if (err.message !== '2FA_REQUIRED') {
      throw err;
    }
  }

  // Step 2: Prompt for 2FA code
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pin = await new Promise(resolve => {
    rl.question('Enter 2FA PIN from email/phone: ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });

  // Step 3: Re-login with 2FA code
  await oauthLogin(pin);
  await discoverCameras();
  log('INFO', 'Setup complete! Credentials saved. You can now run without --setup.');
}

// ============================================
// Poll Loop
// ============================================
let pollCount = 0;

async function pollOnce() {
  try {
    await ensureAuth();
    await discoverCameras();

    if (!blinkCameras.length) {
      log('WARN', 'No Blink cameras found');
      return;
    }

    for (const cam of blinkCameras) {
      const jpeg = await fetchThumbnailJpeg(cam);
      if (jpeg && jpeg.length > 100) {
        // Upload as named snapshot
        const safeName = cam.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const path = `cameras/blink-${safeName}-latest.jpg`;
        const url = await uploadSnapshot(jpeg, path);
        if (url) {
          log('INFO', `Uploaded snapshot for ${cam.name} (${(jpeg.length / 1024).toFixed(1)}KB)`);
        }

        // Also upload as the primary "latest" for first camera
        if (cam === blinkCameras[0]) {
          await uploadSnapshot(jpeg, SNAPSHOT_PATH);
        }
      } else {
        log('WARN', `Thumbnail data too small or null for ${cam.name}`);
      }
    }

    pollCount++;

    // Request new thumbnails every 5th poll (~5 min)
    if (pollCount % 5 === 0) {
      for (const cam of blinkCameras) {
        await requestNewThumbnail(cam);
      }
    }
  } catch (err) {
    log('ERROR', `Poll error: ${err.message}`);
    if (err.message.includes('401') || err.message.includes('Invalid credentials')) {
      blinkAuth = null; // Force re-auth
    }
  }
}

async function startPolling() {
  log('INFO', `Blink Poller starting. Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  // Initial auth + first poll
  await ensureAuth();
  await pollOnce();

  // Polling loop
  setInterval(pollOnce, POLL_INTERVAL_MS);
  log('INFO', 'Polling loop started');
}

// ============================================
// Main
// ============================================
if (process.argv.includes('--setup')) {
  setup2FA().catch(err => {
    log('ERROR', `Setup failed: ${err.message}`);
    process.exit(1);
  });
} else {
  startPolling().catch(err => {
    log('ERROR', `Fatal: ${err.message}`);
    process.exit(1);
  });
}
