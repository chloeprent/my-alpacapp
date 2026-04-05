import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getAppUserWithPermission } from "../_shared/permissions.ts";
import { logApiUsage } from "../_shared/api-usage-log.ts";

const GOVEE_BASE_URL = "https://openapi.api.govee.com/router/api/v1";
const SCENE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface GoveeRequest {
  action: "getDevices" | "controlDevice" | "getDeviceState" | "getScenes" | "syncCapabilities";
  device?: string;
  sku?: string;
  capability?: {
    type: string;
    instance: string;
    value: any;
  };
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
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify auth - require valid Supabase session
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    // Verify user is staff/admin via Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const token = authHeader.replace("Bearer ", "");
    const isInternalCall = token === supabaseServiceKey;
    let userId: string | null = null;

    if (!isInternalCall) {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return jsonResponse({ error: "Invalid token" }, 401);
      }

      // Check granular permission: control_lighting
      const { appUser, hasPermission } = await getAppUserWithPermission(supabase, user.id, "control_lighting");
      userId = appUser?.id ?? null;
      if (!hasPermission) {
        return jsonResponse({ error: "Insufficient permissions" }, 403);
      }
    }

    // Get Govee API key from DB config (primary) or env secret (fallback)
    let goveeApiKey: string | null = null;
    const { data: goveeConfig } = await supabase
      .from("govee_config")
      .select("api_key")
      .eq("id", 1)
      .single();
    goveeApiKey = goveeConfig?.api_key || Deno.env.get("GOVEE_API_KEY") || null;
    if (!goveeApiKey) {
      return jsonResponse({ error: "Govee API key not configured" }, 500);
    }

    const body: GoveeRequest = await req.json();
    const { action } = body;

    let goveeResponse: Response;

    switch (action) {
      case "getDevices": {
        goveeResponse = await fetch(`${GOVEE_BASE_URL}/user/devices`, {
          headers: { "Govee-API-Key": goveeApiKey },
        });
        break;
      }

      case "getDeviceState": {
        goveeResponse = await fetch(`${GOVEE_BASE_URL}/device/state`, {
          method: "POST",
          headers: {
            "Govee-API-Key": goveeApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            requestId: `${Date.now()}`,
            payload: {
              sku: body.sku || "SameModeGroup",
              device: body.device,
            },
          }),
        });
        break;
      }

      case "controlDevice": {
        if (!body.device || !body.capability) {
          return jsonResponse(
            { error: "Missing device or capability for controlDevice" },
            400
          );
        }

        goveeResponse = await fetch(`${GOVEE_BASE_URL}/device/control`, {
          method: "POST",
          headers: {
            "Govee-API-Key": goveeApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            requestId: `${Date.now()}`,
            payload: {
              sku: body.sku || "SameModeGroup",
              device: body.device,
              capability: body.capability,
            },
          }),
        });
        break;
      }

      case "getScenes": {
        if (!body.sku || !body.device) {
          return jsonResponse(
            { error: "Missing sku or device for getScenes" },
            400
          );
        }

        // Check cache first
        const { data: cached } = await supabase
          .from("govee_scene_cache")
          .select("scenes, fetched_at")
          .eq("sku", body.sku)
          .single();

        if (cached?.fetched_at) {
          const cacheAge = Date.now() - new Date(cached.fetched_at).getTime();
          if (cacheAge < SCENE_CACHE_TTL_MS) {
            return jsonResponse({ scenes: cached.scenes, cached: true });
          }
        }

        // Fetch from Govee API
        const scenesResp = await fetch(`${GOVEE_BASE_URL}/device/scenes`, {
          method: "POST",
          headers: {
            "Govee-API-Key": goveeApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            requestId: `${Date.now()}`,
            payload: { sku: body.sku, device: body.device },
          }),
        });

        const scenesResult = await scenesResp.json();
        const capabilities = scenesResult.payload?.capabilities || [];
        const lightSceneCap = capabilities.find(
          (c: any) => c.instance === "lightScene"
        );

        const scenes = lightSceneCap?.parameters?.options?.map((opt: any) => ({
          name: opt.name,
          value: opt.value,
        })) || [];

        // Upsert cache
        await supabase
          .from("govee_scene_cache")
          .upsert({
            sku: body.sku,
            scenes,
            fetched_at: new Date().toISOString(),
          });

        await logApiUsage(supabase, {
          vendor: "govee",
          category: "govee_lighting_control",
          endpoint: "getScenes",
          units: 1,
          unit_type: "api_calls",
          estimated_cost_usd: 0,
          metadata: { sku: body.sku, device: body.device, scenes_count: scenes.length },
          app_user_id: userId,
        });
        return jsonResponse({ scenes, cached: false });
      }

      case "syncCapabilities": {
        // Fetch all devices from Govee API
        const devResp = await fetch(`${GOVEE_BASE_URL}/user/devices`, {
          headers: { "Govee-API-Key": goveeApiKey },
        });

        const devResult = await devResp.json();
        const devices = devResult.data || [];
        let updated = 0;

        for (const device of devices) {
          const { error } = await supabase
            .from("govee_devices")
            .update({ capabilities: device.capabilities })
            .eq("device_id", device.device);
          if (!error) updated++;
        }

        await logApiUsage(supabase, {
          vendor: "govee",
          category: "govee_lighting_control",
          endpoint: "syncCapabilities",
          units: 1,
          unit_type: "api_calls",
          estimated_cost_usd: 0,
          metadata: { synced: updated, total: devices.length },
          app_user_id: userId,
        });
        return jsonResponse({ synced: updated, total: devices.length });
      }

      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400);
    }

    const result = await goveeResponse.json();

    await logApiUsage(supabase, {
      vendor: "govee",
      category: "govee_lighting_control",
      endpoint: action,
      units: 1,
      unit_type: "api_calls",
      estimated_cost_usd: 0,
      metadata: { device: body.device, sku: body.sku },
      app_user_id: userId,
    });

    if (!goveeResponse.ok) {
      console.error(
        `Govee API error [${action}]: status=${goveeResponse.status}`,
        JSON.stringify({ device: body.device, sku: body.sku, response: result })
      );
      // Normalize error field so client always sees it
      const errorMsg =
        result.error || result.message || result.msg || `Govee API error ${goveeResponse.status}`;
      return jsonResponse({ error: errorMsg, goveeStatus: goveeResponse.status }, goveeResponse.status);
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Govee control error:", error.message);
    return jsonResponse({ error: error.message }, 500);
  }
});
