import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getAppUserWithPermission } from "../_shared/permissions.ts";
import { logApiUsage } from "../_shared/api-usage-log.ts";

interface LgControlRequest {
  action: "getStatus" | "control" | "watch" | "unwatch" | "registerPushToken";
  applianceId?: number;
  command?: string; // e.g. "START", "STOP", "POWER_OFF"
  pushToken?: string;
  platform?: "ios" | "android";
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 1. Verify auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return jsonResponse({ error: "Invalid token" }, 401);
    }

    // 2. Check granular permission: view_laundry
    const { appUser, hasPermission } = await getAppUserWithPermission(supabase, user.id, "view_laundry");
    if (!hasPermission) {
      return jsonResponse({ error: "Insufficient permissions" }, 403);
    }

    // 3. Parse request
    const body: LgControlRequest = await req.json();

    // ---- GET STATUS ----
    if (body.action === "getStatus") {
      const { data: appliances, error: appErr } = await supabase
        .from("lg_appliances")
        .select("*")
        .eq("is_active", true)
        .order("display_order", { ascending: true });

      if (appErr) {
        return jsonResponse({ error: appErr.message }, 500);
      }

      // Also return watcher status for this user
      const { data: watchers } = await supabase
        .from("laundry_watchers")
        .select("appliance_id")
        .eq("app_user_id", appUser.id);

      const watchedIds = new Set((watchers || []).map((w: any) => w.appliance_id));

      return jsonResponse({
        appliances: (appliances || []).map((a: any) => ({
          ...a,
          watching: watchedIds.has(a.id),
        })),
      });
    }

    // ---- CONTROL ----
    if (body.action === "control") {
      if (!body.applianceId || !body.command) {
        return jsonResponse({ error: "Missing applianceId or command" }, 400);
      }

      // Load config
      const { data: config } = await supabase
        .from("lg_config")
        .select("*")
        .eq("id", 1)
        .single();

      if (!config?.pat) {
        return jsonResponse({ error: "LG ThinQ PAT not configured" }, 400);
      }

      if (config.test_mode) {
        return jsonResponse({ test_mode: true, message: "No API call made" });
      }

      // Load appliance
      const { data: appliance } = await supabase
        .from("lg_appliances")
        .select("*")
        .eq("id", body.applianceId)
        .eq("is_active", true)
        .single();

      if (!appliance) {
        return jsonResponse({ error: "Appliance not found" }, 404);
      }

      // Check remote control is enabled
      const state = appliance.last_state || {};
      if (!state.remoteControlEnabled) {
        return jsonResponse(
          { error: "Remote control is not enabled on this appliance. Enable it on the physical control panel." },
          400
        );
      }

      // Determine operation mode key based on device type
      const opKey = appliance.device_type === "dryer"
        ? "dryerOperationMode"
        : "washerOperationMode";

      // Send control command to LG ThinQ API
      const controlUrl = `${config.api_base}/devices/${appliance.lg_device_id}/control`;
      const controlBody = {
        operation: { [opKey]: body.command },
      };

      const headers: Record<string, string> = {
        "Authorization": `Bearer ${config.pat}`,
        "x-country": config.country_code || "US",
        "x-message-id": crypto.randomUUID(),
        "x-client-id": config.client_id,
        "x-api-key": "v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3",
        "x-service-phase": "OP",
        "Content-Type": "application/json",
      };

      const apiResponse = await fetch(controlUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(controlBody),
      });

      if (!apiResponse.ok) {
        const errText = await apiResponse.text();
        console.error(`LG control failed: ${apiResponse.status} ${errText.substring(0, 200)}`);
        return jsonResponse(
          { error: `Control command failed (${apiResponse.status})` },
          apiResponse.status
        );
      }

      const result = await apiResponse.json();
      console.log(`LG control ${body.command} on ${appliance.name}: OK`);
      await logApiUsage(supabase, {
        vendor: "lg_thinq",
        category: "lg_laundry_control",
        endpoint: `control/${body.command}`,
        units: 1,
        unit_type: "api_calls",
        estimated_cost_usd: 0,
        metadata: { command: body.command, appliance: appliance.name, device_type: appliance.device_type },
        app_user_id: appUser?.id ?? null,
      });
      return jsonResponse({ success: true, result });
    }

    // ---- WATCH ----
    if (body.action === "watch") {
      if (!body.applianceId) {
        return jsonResponse({ error: "Missing applianceId" }, 400);
      }

      const { error: watchErr } = await supabase
        .from("laundry_watchers")
        .upsert(
          { app_user_id: appUser.id, appliance_id: body.applianceId },
          { onConflict: "app_user_id,appliance_id" }
        );

      if (watchErr) {
        return jsonResponse({ error: watchErr.message }, 500);
      }

      console.log(`User ${appUser.id} watching appliance ${body.applianceId}`);
      return jsonResponse({ watching: true });
    }

    // ---- UNWATCH ----
    if (body.action === "unwatch") {
      if (!body.applianceId) {
        return jsonResponse({ error: "Missing applianceId" }, 400);
      }

      await supabase
        .from("laundry_watchers")
        .delete()
        .eq("app_user_id", appUser.id)
        .eq("appliance_id", body.applianceId);

      console.log(`User ${appUser.id} unwatched appliance ${body.applianceId}`);
      return jsonResponse({ watching: false });
    }

    // ---- REGISTER PUSH TOKEN ----
    if (body.action === "registerPushToken") {
      if (!body.pushToken || !body.platform) {
        return jsonResponse({ error: "Missing pushToken or platform" }, 400);
      }

      const { error: tokenErr } = await supabase
        .from("push_tokens")
        .upsert(
          {
            app_user_id: appUser.id,
            token: body.pushToken,
            platform: body.platform,
            is_active: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "app_user_id,token" }
        );

      if (tokenErr) {
        return jsonResponse({ error: tokenErr.message }, 500);
      }

      console.log(`Push token registered for user ${appUser.id} (${body.platform})`);
      return jsonResponse({ registered: true });
    }

    return jsonResponse({ error: `Unknown action: ${body.action}` }, 400);
  } catch (error) {
    console.error("LG control error:", error.message);
    return jsonResponse({ error: error.message }, 500);
  }
});
