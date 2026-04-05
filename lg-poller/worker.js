/**
 * LG ThinQ Appliance Data Poller
 * Polls LG ThinQ Connect API for washer/dryer state every 30 seconds.
 * Stores results in lg_appliances.last_state (JSONB) via Supabase.
 * Detects cycle completion and sends FCM push + email notifications to watchers.
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ============================================
// Configuration
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000'); // 30s
const API_DELAY_MS = parseInt(process.env.API_DELAY_MS || '1000'); // 1s between API calls
const FCM_PROJECT_ID = process.env.FCM_PROJECT_ID || '';
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'YOUR_APP_NAME <noreply@YOUR_DOMAIN>';

if (!SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');
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
// LG ThinQ Connect API Helper
// ============================================
async function lgApi(config, path, method = 'GET', body = null) {
  const url = `${config.api_base}${path}`;
  const headers = {
    'Authorization': `Bearer ${config.pat}`,
    'x-country': config.country_code || 'US',
    'x-message-id': crypto.randomUUID(),
    'x-client-id': config.client_id,
    'x-api-key': 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3',
    'x-service-phase': 'OP',
    'Content-Type': 'application/json',
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);

  if (response.status === 401) {
    throw new Error('PAT expired or invalid (401). Generate a new one at https://connect-pat.lgthinq.com/');
  }

  if (response.status === 429) {
    throw new Error('Rate limited (429). Consider increasing poll interval.');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LG API ${method} ${path} → ${response.status}: ${text.substring(0, 300)}`);
  }

  return await response.json();
}

// ============================================
// States that indicate the machine is actively running
// ============================================
const RUNNING_STATES = new Set([
  'RUNNING', 'RINSING', 'SPINNING', 'DRYING',
  'STEAM_SOFTENING', 'COOL_DOWN', 'DETECTING',
  'REFRESHING', 'RINSE_HOLD',
]);

// ============================================
// Parse LG device state into our JSONB shape
// ============================================
function parseApplianceState(stateReport, deviceType) {
  // The ThinQ Connect API returns properties grouped by resource
  // E.g., { "runState": { "currentState": "RUNNING" }, "timer": { "remainHour": 0, "remainMinute": 23 } }
  const run = stateReport?.runState || {};
  const timer = stateReport?.timer || {};
  const operation = stateReport?.operation || {};
  const remote = stateReport?.remoteControlEnable || {};

  return {
    currentState: run.currentState || 'POWER_OFF',
    remainHour: timer.remainHour ?? null,
    remainMinute: timer.remainMinute ?? null,
    totalHour: timer.totalHour ?? null,
    totalMinute: timer.totalMinute ?? null,
    relativeHourToStop: timer.relativeHourToStop ?? null,
    relativeMinuteToStop: timer.relativeMinuteToStop ?? null,
    remoteControlEnabled: remote.remoteControlEnabled ?? false,
    operationMode: operation.washerOperationMode || operation.dryerOperationMode || null,
    deviceType,
  };
}

// ============================================
// Detect cycle completion (state transition)
// ============================================
function detectCycleCompletion(previousState, newState) {
  const prevStatus = previousState?.currentState;
  const newStatus = newState?.currentState;

  // Transition from an active state to END means cycle just finished
  return RUNNING_STATES.has(prevStatus) && newStatus === 'END';
}

// ============================================
// FCM Push Notification
// ============================================
let fcmAccessToken = null;
let fcmTokenExpiry = 0;

async function getFcmToken() {
  if (fcmAccessToken && Date.now() < fcmTokenExpiry) {
    return fcmAccessToken;
  }

  if (!GOOGLE_APPLICATION_CREDENTIALS || !FCM_PROJECT_ID) {
    log('warn', 'FCM not configured — skipping push notifications');
    return null;
  }

  try {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      keyFilename: GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    fcmAccessToken = tokenResponse.token;
    fcmTokenExpiry = Date.now() + 50 * 60 * 1000; // 50 min (tokens last 60 min)
    return fcmAccessToken;
  } catch (err) {
    log('error', 'Failed to get FCM token', { error: err.message });
    return null;
  }
}

async function sendFcmPush(tokens, title, body) {
  const accessToken = await getFcmToken();
  if (!accessToken) return;

  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`;

  for (const tokenRecord of tokens) {
    try {
      const payload = {
        message: {
          token: tokenRecord.token,
          notification: { title, body },
          data: { type: 'laundry_done' },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
          android: { notification: { sound: 'default' } },
        },
      };

      const response = await fetch(fcmUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        // Deactivate unregistered tokens
        const errorCode = err?.error?.details?.[0]?.errorCode || err?.error?.status;
        if (errorCode === 'UNREGISTERED' || errorCode === 'NOT_FOUND') {
          log('info', 'Deactivating invalid push token', { tokenId: tokenRecord.id });
          await supabase.from('push_tokens').update({ is_active: false }).eq('id', tokenRecord.id);
        } else {
          log('warn', 'FCM push failed', { status: response.status, error: err });
        }
      } else {
        log('info', 'Push notification sent', { userId: tokenRecord.app_user_id });
      }
    } catch (err) {
      log('error', 'FCM send error', { error: err.message });
    }
  }
}

// ============================================
// Email Notification via Resend
// ============================================
async function sendEmailNotification(emails, typeLabel) {
  if (!RESEND_API_KEY || !emails.length) return;

  const subject = `${typeLabel} is done!`;
  const html = `
    <div style="font-family:'Inter','Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;color:#1f1720;">${typeLabel} Cycle Complete</h2>
      <p style="margin:0 0 16px;color:#444;font-size:15px;">
        Your ${typeLabel.toLowerCase()} cycle has finished. Time to grab your laundry!
      </p>
      <a href="https://YOUR_DOMAIN/residents/appliances.html"
         style="display:inline-block;background:#d97706;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">
        View Appliances
      </a>
      <p style="margin:16px 0 0;color:#999;font-size:12px;">YOUR_PROPERTY_NAME</p>
    </div>`;
  const text = `${typeLabel} Cycle Complete\n\nYour ${typeLabel.toLowerCase()} cycle has finished. Time to grab your laundry!\n\nView: https://YOUR_DOMAIN/residents/appliances.html`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM, to: emails, subject, html, text }),
    });

    if (!response.ok) {
      const err = await response.text();
      log('warn', 'Resend email failed', { status: response.status, error: err.substring(0, 200) });
    } else {
      log('info', `Email notification sent to ${emails.length} recipient(s)`, { to: emails });
    }
  } catch (err) {
    log('error', 'Email send error', { error: err.message });
  }
}

// ============================================
// Notify watchers on cycle completion
// ============================================
async function notifyWatchers(applianceId, applianceName, deviceType) {
  // Get all watchers for this appliance
  const { data: watchers, error: watchErr } = await supabase
    .from('laundry_watchers')
    .select('id, app_user_id')
    .eq('appliance_id', applianceId);

  if (watchErr || !watchers?.length) {
    if (watchErr) log('error', 'Failed to load watchers', { error: watchErr.message });
    return;
  }

  log('info', `Notifying ${watchers.length} watcher(s) for ${applianceName}`);

  const typeLabel = deviceType === 'dryer' ? 'Dryer' : 'Washer';
  const userIds = watchers.map(w => w.app_user_id);

  // Get push tokens for all watchers
  const { data: tokens } = await supabase
    .from('push_tokens')
    .select('id, app_user_id, token, platform')
    .in('app_user_id', userIds)
    .eq('is_active', true);

  if (tokens?.length) {
    await sendFcmPush(
      tokens,
      `${typeLabel} is done!`,
      `Your ${typeLabel.toLowerCase()} cycle has finished. Time to grab your laundry!`
    );
  }

  // Send email notifications
  const { data: users } = await supabase
    .from('app_users')
    .select('email')
    .in('id', userIds);

  const emails = (users || []).map(u => u.email).filter(Boolean);
  if (emails.length) {
    await sendEmailNotification(emails, typeLabel);
  }

  if (!tokens?.length && !emails.length) {
    log('info', 'No push tokens or emails for watchers — no notifications sent');
  }

  // Auto-delete watchers (subscription expires after notification)
  const watcherIds = watchers.map(w => w.id);
  await supabase.from('laundry_watchers').delete().in('id', watcherIds);
  log('info', `Cleared ${watcherIds.length} watcher(s) for ${applianceName}`);
}

// ============================================
// Device Discovery (first run)
// ============================================
async function discoverDevices(config) {
  log('info', 'No appliances in DB — discovering devices from LG ThinQ API...');

  try {
    const result = await lgApi(config, '/devices');
    // ThinQ Connect API returns response as a direct array
    const devices = Array.isArray(result?.response) ? result.response : [];

    if (!devices.length) {
      log('warn', 'No devices found on LG account. Response:', { result: JSON.stringify(result).substring(0, 500) });
      return;
    }

    for (const d of devices) {
      // Device type is nested: d.deviceInfo.deviceType = "DEVICE_WASHER" | "DEVICE_DRYER"
      const info = d.deviceInfo || {};
      const type = (info.deviceType || '').toUpperCase();
      let deviceType = null;
      if (type.includes('WASHER')) deviceType = 'washer';
      else if (type.includes('DRYER')) deviceType = 'dryer';
      else continue; // Skip non-laundry devices

      const name = info.alias || (deviceType === 'washer' ? 'Washer' : 'Dryer');
      const lgDeviceId = d.deviceId;

      const { error } = await supabase
        .from('lg_appliances')
        .upsert({
          lg_device_id: lgDeviceId,
          device_type: deviceType,
          name,
          model: d.modelName || d.model || null,
          display_order: deviceType === 'washer' ? 0 : 1,
          is_active: true,
        }, { onConflict: 'lg_device_id' });

      if (error) {
        log('error', 'Failed to insert device', { lgDeviceId, error: error.message });
      } else {
        log('info', 'Discovered device', { name, lgDeviceId, type: deviceType });
      }
    }
  } catch (err) {
    log('error', 'Device discovery failed', { error: err.message });
  }
}

// ============================================
// Poll a single appliance
// ============================================
async function pollAppliance(config, appliance) {
  try {
    const result = await lgApi(config, `/devices/${appliance.lg_device_id}/state`);
    // The response shape varies; try to extract the state report
    const stateReport = result?.response || result?.result || result || {};

    const newState = parseApplianceState(stateReport, appliance.device_type);
    const previousState = appliance.last_state || {};

    // Check for cycle completion
    if (detectCycleCompletion(previousState, newState)) {
      log('info', `Cycle completed on ${appliance.name}!`, {
        from: previousState.currentState,
        to: newState.currentState,
      });
      await notifyWatchers(appliance.id, appliance.name, appliance.device_type);
    }

    // Also clear watchers when a new cycle starts (new person using machine)
    if (newState.currentState === 'DETECTING' || newState.currentState === 'INITIAL') {
      if (previousState.currentState === 'POWER_OFF' || previousState.currentState === 'END') {
        log('info', `New cycle starting on ${appliance.name} — clearing old watchers`);
        await supabase.from('laundry_watchers').delete().eq('appliance_id', appliance.id);
      }
    }

    // Update DB
    await supabase
      .from('lg_appliances')
      .update({
        last_state: newState,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', appliance.id);

    const stateChanged = previousState.currentState !== newState.currentState;
    if (stateChanged) {
      log('info', 'State changed', {
        name: appliance.name,
        from: previousState.currentState,
        to: newState.currentState,
        remain: newState.remainMinute != null ? `${newState.remainHour || 0}h${newState.remainMinute}m` : null,
      });
    }
  } catch (err) {
    log('error', 'Appliance poll failed', {
      name: appliance.name,
      error: err.message,
    });
  }
}

// ============================================
// Main poll loop
// ============================================
let isProcessing = false;

async function pollAll() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Load config
    const { data: config, error: configErr } = await supabase
      .from('lg_config')
      .select('*')
      .eq('id', 1)
      .single();

    if (configErr || !config) {
      log('error', 'Failed to load lg_config', { error: configErr?.message });
      return;
    }

    if (!config.is_active) return;

    if (!config.pat) {
      // No PAT yet — silent return (user hasn't set up API access)
      return;
    }

    if (config.test_mode) {
      log('info', 'Test mode — skipping API calls');
      return;
    }

    // Load active appliances
    let { data: appliances, error: appErr } = await supabase
      .from('lg_appliances')
      .select('*')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (appErr) {
      log('error', 'Failed to load appliances', { error: appErr.message });
      return;
    }

    // Auto-discover devices on first run
    if (!appliances?.length) {
      await discoverDevices(config);
      // Reload after discovery
      const result = await supabase
        .from('lg_appliances')
        .select('*')
        .eq('is_active', true)
        .order('display_order', { ascending: true });
      appliances = result.data || [];
    }

    if (!appliances.length) {
      return; // No devices found
    }

    for (const appliance of appliances) {
      await pollAppliance(config, appliance);
      if (appliances.indexOf(appliance) < appliances.length - 1) {
        await new Promise(r => setTimeout(r, API_DELAY_MS));
      }
    }

    // Clear config error on success
    if (config.last_error) {
      await supabase
        .from('lg_config')
        .update({ last_error: null, updated_at: new Date().toISOString() })
        .eq('id', 1);
    }
  } catch (err) {
    log('error', 'Poll loop error', { error: err.message });
    // Store error in config for admin visibility
    await supabase
      .from('lg_config')
      .update({ last_error: err.message, updated_at: new Date().toISOString() })
      .eq('id', 1)
      .catch(() => {});
  } finally {
    isProcessing = false;
  }
}

// ============================================
// Startup
// ============================================
async function main() {
  log('info', 'LG ThinQ poller starting', {
    pollInterval: `${POLL_INTERVAL_MS / 1000}s`,
    apiDelay: `${API_DELAY_MS}ms`,
    fcmConfigured: !!(FCM_PROJECT_ID && GOOGLE_APPLICATION_CREDENTIALS),
    resendConfigured: !!RESEND_API_KEY,
  });

  // Verify connectivity
  const { data: config, error } = await supabase
    .from('lg_config')
    .select('pat, is_active, test_mode')
    .eq('id', 1)
    .single();

  if (error) {
    log('error', 'Failed to connect to Supabase', { error: error.message });
    process.exit(1);
  }

  log('info', `Connected to Supabase. PAT ${config?.pat ? 'configured' : 'NOT configured'}.`);

  // Start polling
  setInterval(pollAll, POLL_INTERVAL_MS);
  await pollAll(); // Run immediately
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
