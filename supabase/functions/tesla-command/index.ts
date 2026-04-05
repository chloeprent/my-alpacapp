import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getAppUserWithPermission } from "../_shared/permissions.ts";
import { logApiUsage } from "../_shared/api-usage-log.ts";

const TESLA_TOKEN_URL =
  "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const DEFAULT_FLEET_API_BASE =
  "https://fleet-api.prd.na.vn.cloud.tesla.com";

interface TeslaCommandRequest {
  action?: "exchangeCode"; // OAuth code exchange action
  vehicle_id?: number; // vehicles.id (for vehicle commands)
  command?: "door_unlock" | "door_lock" | "wake_up" | "flash_lights" | "honk_horn";
  code?: string; // OAuth authorization code
  account_id?: number; // tesla_accounts.id (for exchangeCode)
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Map commands to Tesla Fleet API endpoints
const COMMAND_MAP: Record<string, { method: string; pathSuffix: string }> = {
  door_unlock: { method: "POST", pathSuffix: "/command/door_unlock" },
  door_lock: { method: "POST", pathSuffix: "/command/door_lock" },
  wake_up: { method: "POST", pathSuffix: "/wake_up" },
  flash_lights: { method: "POST", pathSuffix: "/command/flash_lights" },
  honk_horn: { method: "POST", pathSuffix: "/command/honk_horn" },
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body first (needed to check action type)
    const body: TeslaCommandRequest = await req.json();

    // ---- OAuth Code Exchange ----
    // Handled before auth check: the OAuth code is single-use and tied to the
    // account's client_id/secret, so session auth is not needed. This avoids
    // failures when the user's Supabase JWT expires during the Tesla redirect.
    if (body.action === "exchangeCode") {
      if (!body.code) {
        return jsonResponse({ error: "Missing authorization code" }, 400);
      }
      if (!body.account_id) {
        return jsonResponse({ error: "Missing account_id" }, 400);
      }

      // Load account to get Fleet API credentials
      const { data: acct, error: acctErr } = await supabase
        .from("tesla_accounts")
        .select("*")
        .eq("id", body.account_id)
        .single();

      if (acctErr || !acct) {
        return jsonResponse({ error: "Account not found" }, 404);
      }

      if (!acct.fleet_client_id || !acct.fleet_client_secret) {
        return jsonResponse({ error: "Fleet API credentials not configured on account" }, 400);
      }

      // Exchange authorization code for tokens
      const tokenParams = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: acct.fleet_client_id,
        client_secret: acct.fleet_client_secret,
        code: body.code,
        redirect_uri: "https://YOUR_DOMAIN/auth/tesla/callback",
        audience: acct.fleet_api_base || DEFAULT_FLEET_API_BASE,
      });

      const tokenResponse = await fetch(TESLA_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams.toString(),
      });

      const tokenData = await tokenResponse.json();
      if (tokenData.error) {
        console.error("OAuth token exchange error:", tokenData);
        return jsonResponse(
          { error: `Token exchange failed: ${tokenData.error_description || tokenData.error}` },
          400
        );
      }

      if (!tokenData.access_token || !tokenData.refresh_token) {
        return jsonResponse({ error: "Token response missing tokens" }, 500);
      }

      // Save tokens to account — clear needs_reauth since we have fresh tokens
      const { error: updateErr } = await supabase
        .from("tesla_accounts")
        .update({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          token_expires_at: new Date(
            Date.now() + tokenData.expires_in * 1000
          ).toISOString(),
          last_token_refresh_at: new Date().toISOString(),
          last_error: null,
          needs_reauth: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", body.account_id);

      if (updateErr) {
        console.error("Failed to save tokens:", updateErr.message);
        return jsonResponse({ error: `Failed to save tokens: ${updateErr.message}` }, 500);
      }

      console.log(`Tesla OAuth tokens saved for account ${body.account_id}`);
      await logApiUsage(supabase, {
        vendor: "tesla",
        category: "tesla_vehicle_command",
        endpoint: "oauth/token_exchange",
        units: 1,
        unit_type: "api_calls",
        estimated_cost_usd: 0,
        metadata: { account_id: body.account_id },
      });
      return jsonResponse({ success: true, account_id: body.account_id });
    }

    // ---- Vehicle Commands (require auth) ----
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");

    // Allow trusted internal calls from PAI (service role key = already permission-checked)
    const isInternalCall = token === supabaseServiceKey;

    let appUser: any = null;
    if (!isInternalCall) {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return jsonResponse({ error: "Invalid token" }, 401);
      }

      // Check granular permission: control_cars
      const result = await getAppUserWithPermission(supabase, user.id, "control_cars");
      appUser = result.appUser;
      if (!result.hasPermission) {
        return jsonResponse({ error: "Insufficient permissions" }, 403);
      }
    }

    const { vehicle_id, command } = body;

    if (!vehicle_id || !command) {
      return jsonResponse({ error: "Missing vehicle_id or command" }, 400);
    }

    const commandConfig = COMMAND_MAP[command];
    if (!commandConfig) {
      return jsonResponse({ error: `Unknown command: ${command}` }, 400);
    }

    // 4. Load vehicle + account + drivers
    const { data: vehicle, error: vehicleError } = await supabase
      .from("vehicles")
      .select("*, tesla_accounts(*), vehicle_drivers(person_id)")
      .eq("id", vehicle_id)
      .eq("is_active", true)
      .single();

    if (vehicleError || !vehicle) {
      return jsonResponse({ error: "Vehicle not found" }, 404);
    }

    // 5. Non-owner/non-driver restriction: only allow commands when battery >50% AND plugged in
    if (!isInternalCall && appUser) {
      const isOwner = (appUser.person_id && vehicle.owner_id === appUser.person_id) ||
        (account && account.app_user_id === appUser.id);
      const isDriver = appUser.person_id &&
        (vehicle.vehicle_drivers || []).some((d: any) => d.person_id === appUser.person_id);

      if (!isOwner && !isDriver) {
        const state = vehicle.last_state || {};
        const batteryOk = typeof state.battery_level === "number" && state.battery_level > 50;
        const pluggedIn = state.charging_state && state.charging_state !== "Disconnected";

        if (!batteryOk || !pluggedIn) {
          const reasons = [];
          if (!pluggedIn) reasons.push("not plugged in");
          if (!batteryOk) reasons.push(`battery is ${state.battery_level ?? "unknown"}%`);
          return jsonResponse(
            { error: `Only assigned drivers can control this vehicle (${reasons.join(", ")})` },
            403
          );
        }
      }
    }

    const account = vehicle.tesla_accounts;
    if (!account || !account.is_active) {
      return jsonResponse({ error: "Tesla account not active" }, 400);
    }

    if (!account.fleet_client_id || !account.fleet_client_secret) {
      return jsonResponse(
        { error: "Fleet API credentials not configured" },
        400
      );
    }

    // Check if account needs re-authorization
    if (account.needs_reauth) {
      return jsonResponse(
        { error: "Tesla account needs re-authorization. Please reconnect from the Cars page." },
        401
      );
    }

    const apiBase = account.fleet_api_base || DEFAULT_FLEET_API_BASE;

    // 5. Get valid access token (with retry-on-401 pattern)
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(supabase, account, apiBase);
    } catch (err) {
      // If refresh failed, mark account for re-auth if it's a login_required error
      if (err.message?.includes("login_required") || err.message?.includes("invalid_grant")) {
        await markNeedsReauth(supabase, account.id, err.message);
        return jsonResponse(
          { error: "Tesla session expired. Please reconnect your Tesla account.", needs_reauth: true },
          401
        );
      }
      throw err;
    }

    // 6. If vehicle is asleep and command is not wake_up, wake it first
    if (command !== "wake_up" && vehicle.vehicle_state === "asleep") {
      console.log(`Vehicle ${vehicle.name} is asleep, waking up first...`);
      const wakeResult = await wakeVehicle(
        accessToken,
        vehicle.vehicle_api_id,
        apiBase
      );
      if (!wakeResult.success) {
        return jsonResponse(
          {
            error: `Failed to wake vehicle: ${wakeResult.error}`,
            vehicle_state: "asleep",
          },
          503
        );
      }
      // Update vehicle state in DB
      await supabase
        .from("vehicles")
        .update({
          vehicle_state: "online",
          updated_at: new Date().toISOString(),
        })
        .eq("id", vehicle.id);
    }

    // 7. Send command (with retry on 401)
    const commandUrl = `${apiBase}/api/1/vehicles/${vehicle.vehicle_api_id}${commandConfig.pathSuffix}`;
    console.log(
      `Sending ${command} to ${vehicle.name} (${vehicle.vehicle_api_id})`
    );

    let cmdResponse = await fetch(commandUrl, {
      method: commandConfig.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    // Retry once on 401: re-read token from DB (poller may have refreshed it)
    if (cmdResponse.status === 401) {
      console.log(`Command got 401, attempting token re-read and retry...`);
      try {
        accessToken = await retryWithFreshToken(supabase, account, apiBase);
        cmdResponse = await fetch(commandUrl, {
          method: commandConfig.method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        });
      } catch (retryErr) {
        if (retryErr.message?.includes("login_required") || retryErr.message?.includes("invalid_grant")) {
          await markNeedsReauth(supabase, account.id, retryErr.message);
          return jsonResponse(
            { error: "Tesla session expired. Please reconnect your Tesla account.", needs_reauth: true },
            401
          );
        }
        return jsonResponse(
          { error: `Command failed after token refresh: ${retryErr.message}` },
          500
        );
      }
    }

    if (!cmdResponse.ok) {
      const errText = await cmdResponse.text();
      console.error(
        `Command failed: ${cmdResponse.status} ${errText.substring(0, 200)}`
      );
      return jsonResponse(
        {
          error: `Command failed (${cmdResponse.status})`,
          details: errText.substring(0, 200),
        },
        cmdResponse.status
      );
    }

    const cmdData = await cmdResponse.json();
    console.log(
      `Command ${command} result for ${vehicle.name}:`,
      JSON.stringify(cmdData)
    );

    await logApiUsage(supabase, {
      vendor: "tesla",
      category: "tesla_vehicle_command",
      endpoint: `command/${command}`,
      units: 1,
      unit_type: "api_calls",
      estimated_cost_usd: 0,
      metadata: { command, vehicle_name: vehicle.name, vehicle_id: vehicle.id },
      app_user_id: appUser?.id ?? null,
    });

    // 8. Update lock state in DB if it was a lock/unlock command
    if (command === "door_lock" || command === "door_unlock") {
      const newLockState = command === "door_lock";
      const currentState = vehicle.last_state || {};
      await supabase
        .from("vehicles")
        .update({
          last_state: { ...currentState, locked: newLockState },
          updated_at: new Date().toISOString(),
        })
        .eq("id", vehicle.id);
    }

    return jsonResponse({
      success: true,
      result: cmdData.response?.result ?? true,
      vehicle_name: vehicle.name,
      command,
    });
  } catch (error) {
    console.error("Tesla command error:", error.message);
    return jsonResponse({ error: error.message }, 500);
  }
});

// ============================================
// Wake vehicle with polling (up to 30s)
// ============================================
async function wakeVehicle(
  accessToken: string,
  vehicleApiId: number,
  apiBase: string
): Promise<{ success: boolean; error?: string }> {
  const wakeUrl = `${apiBase}/api/1/vehicles/${vehicleApiId}/wake_up`;

  const wakeRes = await fetch(wakeUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!wakeRes.ok) {
    const errText = await wakeRes.text();
    return { success: false, error: `Wake failed: ${wakeRes.status}` };
  }

  // Poll for online state (up to 30s, every 3s)
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));

    const checkRes = await fetch(
      `${apiBase}/api/1/vehicles/${vehicleApiId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (checkRes.ok) {
      const checkData = await checkRes.json();
      if (checkData.response?.state === "online") {
        console.log(`Vehicle woke up after ${(i + 1) * 3}s`);
        return { success: true };
      }
    }
  }

  return { success: false, error: "Vehicle did not wake up within 30s" };
}

// ============================================
// Mark account as needing re-authorization
// ============================================
async function markNeedsReauth(supabase: any, accountId: number, reason: string) {
  console.error(`Marking account ${accountId} for re-auth: ${reason}`);
  await supabase
    .from("tesla_accounts")
    .update({
      needs_reauth: true,
      last_error: `Re-authorization required: ${reason}`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", accountId);
}

// ============================================
// Retry with fresh token from DB
// Re-reads the account in case the poller already refreshed it.
// If the token in DB is the same (stale), attempts a full refresh.
// ============================================
async function retryWithFreshToken(
  supabase: any,
  staleAccount: any,
  apiBase: string
): Promise<string> {
  // Re-read account from DB — the poller may have already refreshed
  const { data: freshAccount, error } = await supabase
    .from("tesla_accounts")
    .select("*")
    .eq("id", staleAccount.id)
    .single();

  if (error || !freshAccount) {
    throw new Error("Failed to re-read account");
  }

  // If DB has a different (newer) access token, use it
  if (
    freshAccount.access_token &&
    freshAccount.access_token !== staleAccount.access_token &&
    freshAccount.token_expires_at &&
    new Date(freshAccount.token_expires_at) > new Date(Date.now() + 60 * 1000)
  ) {
    console.log(`Using token refreshed by poller for account ${freshAccount.id}`);
    return freshAccount.access_token;
  }

  // Same token — attempt our own refresh
  console.log(`Token still stale, refreshing ourselves for account ${freshAccount.id}`);
  return await refreshToken(supabase, freshAccount, apiBase);
}

// ============================================
// Token refresh (with login_required detection)
// ============================================
async function getValidAccessToken(
  supabase: any,
  account: any,
  apiBase: string
): Promise<string> {
  // Check if current token is still valid (5 min buffer)
  if (account.access_token && account.token_expires_at) {
    const expiresAt = new Date(account.token_expires_at);
    if (expiresAt > new Date(Date.now() + 5 * 60 * 1000)) {
      return account.access_token;
    }
  }

  // Token expired or missing — re-read from DB first (poller may have refreshed)
  const { data: freshAccount } = await supabase
    .from("tesla_accounts")
    .select("*")
    .eq("id", account.id)
    .single();

  if (freshAccount?.access_token && freshAccount.token_expires_at) {
    const expiresAt = new Date(freshAccount.token_expires_at);
    if (expiresAt > new Date(Date.now() + 60 * 1000)) {
      console.log(`Using token refreshed by poller for account ${account.id}`);
      return freshAccount.access_token;
    }
  }

  // Still expired — do our own refresh
  const acctToRefresh = freshAccount || account;
  return await refreshToken(supabase, acctToRefresh, apiBase);
}

// ============================================
// Core token refresh logic
// ============================================
async function refreshToken(
  supabase: any,
  account: any,
  apiBase: string
): Promise<string> {
  if (!account.refresh_token) {
    throw new Error("No refresh token available — login_required");
  }

  console.log(`Refreshing Fleet API token for account ${account.id}`);

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: account.fleet_client_id,
    client_secret: account.fleet_client_secret,
    refresh_token: account.refresh_token,
  });

  const tokenResponse = await fetch(TESLA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  // Check for non-OK response first (may return HTML error page)
  if (!tokenResponse.ok) {
    let errText = "";
    try { errText = await tokenResponse.text(); } catch (_) {}
    errText = errText.substring(0, 200).replace(/<[^>]*>/g, "").trim();
    // 400/401/403 from the token endpoint all mean the refresh token is invalid
    if (tokenResponse.status === 400 || tokenResponse.status === 401 || tokenResponse.status === 403) {
      throw new Error(`login_required: Token refresh returned ${tokenResponse.status}: ${errText}`);
    }
    throw new Error(`Token refresh failed ${tokenResponse.status}: ${errText}`);
  }

  // Parse JSON (Tesla may return HTML even on 200 in edge cases)
  let tokenData: any;
  try {
    tokenData = await tokenResponse.json();
  } catch (_) {
    throw new Error("login_required: Token response was not valid JSON (likely auth page redirect)");
  }

  // Detect terminal auth failures that require user re-authorization
  if (tokenData.error) {
    const errMsg = tokenData.error_description || tokenData.error;
    if (
      tokenData.error === "login_required" ||
      tokenData.error === "invalid_grant"
    ) {
      throw new Error(`login_required: ${errMsg}`);
    }
    throw new Error(`Token refresh failed: ${errMsg}`);
  }

  if (!tokenData.access_token) {
    throw new Error("Token refresh response missing access_token");
  }

  // CRITICAL: Save new refresh_token IMMEDIATELY (old one is now invalid)
  const updateData: any = {
    access_token: tokenData.access_token,
    token_expires_at: new Date(
      Date.now() + tokenData.expires_in * 1000
    ).toISOString(),
    last_token_refresh_at: new Date().toISOString(),
    last_error: null,
    needs_reauth: false,
    updated_at: new Date().toISOString(),
  };

  // Fleet API refresh tokens rotate — save the new one
  if (tokenData.refresh_token) {
    updateData.refresh_token = tokenData.refresh_token;
  }

  const { error: updateErr } = await supabase
    .from("tesla_accounts")
    .update(updateData)
    .eq("id", account.id);

  if (updateErr) {
    console.error("CRITICAL: Failed to save new token!", updateErr.message);
    throw new Error(`Failed to persist token: ${updateErr.message}`);
  }

  return tokenData.access_token;
}
