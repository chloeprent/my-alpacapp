/**
 * Tesla Vehicle Data Poller
 * Polls Tesla Fleet API for vehicle state every 5 minutes.
 * Stores results in vehicles.last_state (JSONB) via Supabase.
 *
 * Each tesla_accounts row represents a separate Tesla account.
 * Fleet API credentials (client_id, client_secret) stored per account.
 * Refresh tokens rotate on every refresh (single-use).
 *
 * Robust 401 handling:
 * - On 401 from Tesla API: re-read account from DB (edge function may have refreshed)
 * - If DB token is newer, retry with it
 * - If DB token is stale, attempt our own refresh
 * - On terminal auth failure (login_required/invalid_grant), set needs_reauth flag
 */

import { createClient } from '@supabase/supabase-js';

// ============================================
// Configuration
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '300000'); // 5 min
const API_DELAY_MS = parseInt(process.env.API_DELAY_MS || '2000'); // 2s between API calls

const TESLA_TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const DEFAULT_FLEET_API_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';

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
// Tesla Fleet API Helper
// ============================================
async function teslaApi(accessToken, path, apiBase = DEFAULT_FLEET_API_BASE) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'YOUR_APP_NAMEPoller/1.0',
    },
  });

  if (response.status === 408 || response.status === 504) {
    // Vehicle is sleeping or timed out
    return { response: null, sleeping: true };
  }

  if (response.status === 401) {
    throw Object.assign(new Error('Token expired or invalid (401)'), { status: 401 });
  }

  if (response.status === 412) {
    throw new Error('Fleet API requires new tokens — old Owner API tokens not accepted (412)');
  }

  if (response.status === 429) {
    throw new Error('Rate limited (429)');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tesla API ${response.status}: ${text.substring(0, 200)}`);
  }

  return await response.json();
}

// ============================================
// Core Token Refresh
// ============================================
async function refreshToken(account) {
  if (!account.refresh_token) {
    throw Object.assign(new Error('No refresh token available — login_required'), { terminal: true });
  }

  if (!account.fleet_client_id || !account.fleet_client_secret) {
    throw new Error('Fleet API client_id/client_secret not configured');
  }

  log('info', 'Refreshing token', { accountId: account.id, owner: account.owner_name });

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: account.fleet_client_id,
    client_secret: account.fleet_client_secret,
    refresh_token: account.refresh_token,
  });

  const response = await fetch(TESLA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  // Check for non-OK response first (may return HTML error page)
  if (!response.ok) {
    let errText;
    try { errText = await response.text(); } catch (_) { errText = ''; }
    // Truncate and sanitize HTML
    errText = errText.substring(0, 200).replace(/<[^>]*>/g, '').trim();
    // 400/401/403 from the token endpoint all mean the refresh token is invalid
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw Object.assign(
        new Error(`login_required: Token refresh returned ${response.status}: ${errText}`),
        { terminal: true }
      );
    }
    throw new Error(`Token refresh failed ${response.status}: ${errText}`);
  }

  // Parse JSON response (Tesla may return HTML even on 200 in edge cases)
  let data;
  try {
    data = await response.json();
  } catch (parseErr) {
    throw Object.assign(
      new Error(`login_required: Token response was not valid JSON (likely auth page redirect)`),
      { terminal: true }
    );
  }

  // Detect terminal auth failures that require user re-authorization
  if (data.error) {
    const errMsg = data.error_description || data.error;
    if (
      data.error === 'login_required' ||
      data.error === 'invalid_grant'
    ) {
      throw Object.assign(new Error(`login_required: ${errMsg}`), { terminal: true });
    }
    throw new Error(`Token refresh failed: ${errMsg}`);
  }

  if (!data.access_token) {
    throw new Error('Token refresh response missing access_token');
  }

  // CRITICAL: Save new refresh_token IMMEDIATELY (old one is now invalid)
  const updateData = {
    access_token: data.access_token,
    token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    last_token_refresh_at: new Date().toISOString(),
    last_error: null,
    needs_reauth: false,
    updated_at: new Date().toISOString(),
  };

  // Fleet API refresh tokens rotate — always save the new one
  if (data.refresh_token) {
    updateData.refresh_token = data.refresh_token;
  }

  const { error: updateErr } = await supabase
    .from('tesla_accounts')
    .update(updateData)
    .eq('id', account.id);

  if (updateErr) {
    log('error', 'CRITICAL: Failed to save new refresh token!', {
      accountId: account.id,
      error: updateErr.message,
    });
    throw new Error(`Failed to persist refresh token: ${updateErr.message}`);
  }

  log('info', 'Token refreshed', { accountId: account.id });
  return data.access_token;
}

// ============================================
// Get valid access token (with DB re-read)
// ============================================
async function getValidAccessToken(account) {
  // If token is still valid (with 5-min buffer), return it
  if (
    account.access_token &&
    account.token_expires_at &&
    new Date(account.token_expires_at) > new Date(Date.now() + 5 * 60 * 1000)
  ) {
    return { token: account.access_token, account };
  }

  // Token expired — re-read from DB first (edge function may have refreshed)
  const { data: freshAccount } = await supabase
    .from('tesla_accounts')
    .select('*')
    .eq('id', account.id)
    .single();

  if (freshAccount?.access_token && freshAccount.token_expires_at) {
    const expiresAt = new Date(freshAccount.token_expires_at);
    if (expiresAt > new Date(Date.now() + 60 * 1000)) {
      log('info', 'Using token refreshed elsewhere', { accountId: account.id });
      return { token: freshAccount.access_token, account: freshAccount };
    }
  }

  // Still expired — do our own refresh
  const acctToRefresh = freshAccount || account;
  const token = await refreshToken(acctToRefresh);
  return { token, account: acctToRefresh };
}

// ============================================
// Retry API call on 401 (re-read token from DB, then refresh if needed)
// ============================================
async function retryOn401(account, apiCall) {
  try {
    return await apiCall(account._currentToken);
  } catch (err) {
    if (err.status !== 401) throw err;

    log('warn', 'Got 401, re-reading account from DB...', { accountId: account.id });

    // Re-read account — another process (edge function) may have refreshed
    const { data: freshAccount } = await supabase
      .from('tesla_accounts')
      .select('*')
      .eq('id', account.id)
      .single();

    if (!freshAccount) throw new Error('Failed to re-read account');

    // If DB has a newer token, try with it
    if (
      freshAccount.access_token &&
      freshAccount.access_token !== account._currentToken &&
      freshAccount.token_expires_at &&
      new Date(freshAccount.token_expires_at) > new Date(Date.now() + 60 * 1000)
    ) {
      log('info', 'Found newer token in DB, retrying...', { accountId: account.id });
      account._currentToken = freshAccount.access_token;
      return await apiCall(freshAccount.access_token);
    }

    // Same token — attempt our own refresh
    log('info', 'Token still stale, refreshing ourselves...', { accountId: account.id });
    const newToken = await refreshToken(freshAccount);
    account._currentToken = newToken;
    return await apiCall(newToken);
  }
}

// ============================================
// Mark account as needing re-authorization
// ============================================
async function markNeedsReauth(accountId, reason) {
  log('error', `Marking account ${accountId} for re-auth`, { reason });
  await supabase
    .from('tesla_accounts')
    .update({
      needs_reauth: true,
      last_error: `Re-authorization required: ${reason}`,
      updated_at: new Date().toISOString(),
    })
    .eq('id', accountId);
}

// ============================================
// Parse Tesla vehicle_data into our JSONB shape
// ============================================
function parseVehicleState(data) {
  const cs = data.charge_state || {};
  const ds = data.drive_state || {};
  const vs = data.vehicle_state || {};
  const cls = data.climate_state || {};

  return {
    battery_level: cs.battery_level ?? null,
    battery_range_mi: cs.battery_range != null ? Math.round(cs.battery_range * 10) / 10 : null,
    charging_state: cs.charging_state || null,
    charge_limit_soc: cs.charge_limit_soc ?? null,
    charge_rate_mph: cs.charge_rate ?? null,
    minutes_to_full: cs.minutes_to_full_charge ?? null,
    charger_power_kw: cs.charger_power ?? null,
    odometer_mi: vs.odometer != null ? Math.round(vs.odometer * 10) / 10 : null,
    inside_temp_f: cls.inside_temp != null ? Math.round(cls.inside_temp * 9 / 5 + 32) : null,
    outside_temp_f: cls.outside_temp != null ? Math.round(cls.outside_temp * 9 / 5 + 32) : null,
    climate_on: cls.is_climate_on ?? null,
    locked: vs.locked ?? null,
    sentry_mode: vs.sentry_mode ?? null,
    latitude: ds.latitude ?? null,
    longitude: ds.longitude ?? null,
    speed_mph: ds.speed ?? null,
    heading: ds.heading ?? null,
    tpms_fl_psi: vs.tpms_pressure_fl != null ? Math.round(vs.tpms_pressure_fl * 14.5038) : null,
    tpms_fr_psi: vs.tpms_pressure_fr != null ? Math.round(vs.tpms_pressure_fr * 14.5038) : null,
    tpms_rl_psi: vs.tpms_pressure_rl != null ? Math.round(vs.tpms_pressure_rl * 14.5038) : null,
    tpms_rr_psi: vs.tpms_pressure_rr != null ? Math.round(vs.tpms_pressure_rr * 14.5038) : null,
    tpms_warn_fl: vs.tpms_soft_warning_fl ?? null,
    tpms_warn_fr: vs.tpms_soft_warning_fr ?? null,
    tpms_warn_rl: vs.tpms_soft_warning_rl ?? null,
    tpms_warn_rr: vs.tpms_soft_warning_rr ?? null,
    software_version: vs.car_version || null,
    // Closures from vehicle_state (0 = closed, non-zero = open)
    df: vs.df ?? null,   // driver front door
    pf: vs.pf ?? null,   // passenger front door
    dr: vs.dr ?? null,   // driver rear door
    pr: vs.pr ?? null,   // passenger rear door
    ft: vs.ft ?? null,   // frunk (front trunk)
    rt: vs.rt ?? null,   // rear trunk
    // Windows (0 = closed, non-zero = open)
    fd_window: vs.fd_window ?? null,
    fp_window: vs.fp_window ?? null,
    rd_window: vs.rd_window ?? null,
    rp_window: vs.rp_window ?? null,
    // Software update status
    software_update: vs.software_update?.status && vs.software_update.status !== '' ? {
      status: vs.software_update.status,
      version: vs.software_update.version?.trim() || null,
      download_pct: vs.software_update.download_perc ?? null,
      install_pct: vs.software_update.install_perc ?? null,
    } : null,
  };
}

// ============================================
// Poll a single account
// ============================================
async function pollAccount(account) {
  // Skip accounts that need re-authorization
  if (account.needs_reauth) {
    log('warn', 'Account needs re-auth, skipping', { accountId: account.id, owner: account.owner_name });
    return;
  }

  let accessToken;
  try {
    const result = await getValidAccessToken(account);
    accessToken = result.token;
    account = result.account; // Use potentially-refreshed account data
  } catch (err) {
    log('error', 'Token refresh failed', {
      accountId: account.id,
      owner: account.owner_name,
      error: err.message,
    });

    // Terminal auth failure — mark for re-auth, don't keep retrying
    if (err.terminal) {
      await markNeedsReauth(account.id, err.message);
    } else {
      await supabase
        .from('tesla_accounts')
        .update({ last_error: err.message, updated_at: new Date().toISOString() })
        .eq('id', account.id);
    }
    return;
  }

  // Store current token on account object for retryOn401 to track
  account._currentToken = accessToken;

  const apiBase = account.fleet_api_base || DEFAULT_FLEET_API_BASE;

  // 1. Get vehicle list (does NOT wake sleeping cars) — with 401 retry
  let vehicleList;
  try {
    vehicleList = await retryOn401(account, (token) =>
      teslaApi(token, '/api/1/vehicles', apiBase)
    );
  } catch (err) {
    log('error', 'Vehicle list fetch failed', {
      accountId: account.id,
      error: err.message,
    });

    if (err.terminal) {
      await markNeedsReauth(account.id, err.message);
    } else {
      await supabase
        .from('tesla_accounts')
        .update({ last_error: err.message, updated_at: new Date().toISOString() })
        .eq('id', account.id);
    }
    return;
  }

  // Update current token from retry (may have changed)
  accessToken = account._currentToken;

  const vehicles = vehicleList?.response || [];
  if (!vehicles.length) {
    log('warn', 'No vehicles found', { accountId: account.id });
    return;
  }

  // 2. Process each vehicle
  for (const v of vehicles) {
    // Match by Tesla's unique vehicle_api_id (for known vehicles)
    let { data: dbVehicle } = await supabase
      .from('vehicles')
      .select('*')
      .eq('vehicle_api_id', v.id)
      .eq('is_active', true)
      .maybeSingle();

    // Fallback: match unlinked vehicle by account_id (first poll, before api_id is set)
    if (!dbVehicle) {
      const { data: unlinked } = await supabase
        .from('vehicles')
        .select('*')
        .eq('account_id', account.id)
        .eq('is_active', true)
        .is('vehicle_api_id', null)
        .limit(1)
        .maybeSingle();
      dbVehicle = unlinked;
    }

    if (!dbVehicle) {
      log('warn', 'No matching DB vehicle', { accountId: account.id, apiId: v.id, apiName: v.display_name });
      continue;
    }

    // Update vehicle_api_id and VIN if not set
    if (!dbVehicle.vehicle_api_id || !dbVehicle.vin) {
      await supabase
        .from('vehicles')
        .update({
          vehicle_api_id: v.id,
          vin: v.vin,
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbVehicle.id);
    }

    // One-time: fetch vehicle_config if not yet stored (only when online)
    if (!dbVehicle.vehicle_config && v.state === 'online') {
      try {
        await new Promise(r => setTimeout(r, API_DELAY_MS));
        const configData = await retryOn401(account, (token) =>
          teslaApi(
            token,
            `/api/1/vehicles/${v.id}/vehicle_data?endpoints=${encodeURIComponent('vehicle_config')}`,
            apiBase
          )
        );
        if (configData.response?.vehicle_config) {
          await supabase
            .from('vehicles')
            .update({
              vehicle_config: configData.response.vehicle_config,
              updated_at: new Date().toISOString(),
            })
            .eq('id', dbVehicle.id);
          log('info', 'Vehicle config saved', {
            name: dbVehicle.name,
            carType: configData.response.vehicle_config.car_type,
            exteriorColor: configData.response.vehicle_config.exterior_color,
          });
        }
      } catch (err) {
        log('warn', 'vehicle_config fetch failed (will retry next poll)', {
          name: dbVehicle.name,
          error: err.message,
        });
      }
    }

    // If vehicle is asleep or offline, just update state — don't wake it
    if (v.state === 'asleep' || v.state === 'offline') {
      log('info', 'Vehicle sleeping/offline', {
        name: dbVehicle.name,
        state: v.state,
      });
      await supabase
        .from('vehicles')
        .update({
          vehicle_state: v.state,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbVehicle.id);
      continue;
    }

    // Vehicle is online — fetch full data
    await new Promise(r => setTimeout(r, API_DELAY_MS));

    try {
      const vehicleData = await retryOn401(account, (token) =>
        teslaApi(
          token,
          `/api/1/vehicles/${v.id}/vehicle_data?endpoints=${encodeURIComponent('location_data;charge_state;climate_state;vehicle_state;drive_state')}`,
          apiBase
        )
      );

      if (vehicleData.sleeping) {
        // Vehicle went to sleep between list and data call
        await supabase
          .from('vehicles')
          .update({
            vehicle_state: 'asleep',
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', dbVehicle.id);
        continue;
      }

      const state = parseVehicleState(vehicleData.response);

      await supabase
        .from('vehicles')
        .update({
          vehicle_state: 'online',
          last_state: state,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbVehicle.id);

      log('info', 'Vehicle updated', {
        name: dbVehicle.name,
        battery: state.battery_level,
        state: 'online',
      });
    } catch (err) {
      log('error', 'Vehicle data fetch failed', {
        name: dbVehicle.name,
        error: err.message,
      });
      // If terminal, mark for reauth — otherwise just log
      if (err.terminal) {
        await markNeedsReauth(account.id, err.message);
        return; // Stop processing this account
      }
    }
  }

  // Clear account error on success
  await supabase
    .from('tesla_accounts')
    .update({ last_error: null, updated_at: new Date().toISOString() })
    .eq('id', account.id);
}

// ============================================
// Main poll loop
// ============================================
let isProcessing = false;

async function pollAllAccounts() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Fetch active accounts that have refresh tokens and Fleet API credentials
    const { data: accounts, error } = await supabase
      .from('tesla_accounts')
      .select('*')
      .eq('is_active', true)
      .not('refresh_token', 'is', null)
      .not('fleet_client_id', 'is', null);

    if (error) {
      log('error', 'Failed to fetch accounts', { error: error.message });
      return;
    }

    if (!accounts?.length) {
      // No connected accounts yet — this is normal during initial setup
      return;
    }

    log('info', `Polling ${accounts.length} account(s)`);

    for (const account of accounts) {
      try {
        await pollAccount(account);
      } catch (err) {
        log('error', 'Account poll failed', {
          accountId: account.id,
          owner: account.owner_name,
          error: err.message,
        });
      }
      // Delay between accounts
      if (accounts.indexOf(account) < accounts.length - 1) {
        await new Promise(r => setTimeout(r, API_DELAY_MS));
      }
    }
  } catch (err) {
    log('error', 'Poll loop error', { error: err.message });
  } finally {
    isProcessing = false;
  }
}

// ============================================
// Startup
// ============================================
async function main() {
  log('info', 'Tesla poller starting', {
    pollInterval: `${POLL_INTERVAL_MS / 1000}s`,
    apiDelay: `${API_DELAY_MS}ms`,
    defaultApiBase: DEFAULT_FLEET_API_BASE,
    tokenUrl: TESLA_TOKEN_URL,
  });

  // Verify connectivity
  const { count, error } = await supabase
    .from('tesla_accounts')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true)
    .not('refresh_token', 'is', null);

  if (error) {
    log('error', 'Failed to connect to Supabase', { error: error.message });
    process.exit(1);
  }

  log('info', `Connected to Supabase. ${count || 0} active account(s) with tokens.`);

  // Start polling
  setInterval(pollAllAccounts, POLL_INTERVAL_MS);
  await pollAllAccounts(); // Run immediately
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
