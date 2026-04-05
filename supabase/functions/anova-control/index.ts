import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getAppUserWithPermission } from "../_shared/permissions.ts";

interface AnovaControlRequest {
  action: "getStatus" | "startCook" | "stopCook" | "setTemperatureUnit";
  ovenId?: number;
  stages?: CookStage[];
  temperatureUnit?: "C" | "F";
}

interface CookStage {
  id: string;
  type: string;
  userActionRequired: boolean;
  temperatureBulbs: {
    mode: "dry" | "wet";
    dry: { setpoint: { celsius: number } };
    wet?: { setpoint: { celsius: number } };
  };
  heatingElements: {
    top: { on: boolean };
    bottom: { on: boolean };
    rear: { on: boolean };
  };
  fan: { speed: number };
  vent: { open: boolean };
  steamGenerators?: {
    mode: string;
    relativeHumidity?: { setpoint: number };
    steamPercentage?: { setpoint: number };
  };
  timer?: {
    initial: number;
    startType: string;
  };
  rackPosition?: number;
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

function fToC(f: number): number {
  return Math.round(((f - 32) * 5) / 9 * 2) / 2;
}

/**
 * Opens a WebSocket to the Anova cloud, authenticates, and waits for device events.
 * Returns the cookerId and latest state once EVENT_APO_STATE arrives.
 */
function connectAnova(
  wsUrl: string,
  pat: string,
  timeoutMs = 15000,
): Promise<{ ws: WebSocket; cookerId: string; ovenType: string; state: any; firmwareVersion: string | null }> {
  return new Promise((resolve, reject) => {
    const url = `${wsUrl}?token=${pat}&supportedAccessories=APO`;
    const ws = new WebSocket(url);

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("WebSocket connection timeout"));
    }, timeoutMs);

    let cookerId: string | null = null;
    let ovenType = "oven_v1";

    ws.onopen = () => {
      console.log("Anova WebSocket connected");
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : "{}");

        if (msg.command === "EVENT_APO_WIFI_LIST") {
          const devices = msg.payload;
          if (Array.isArray(devices) && devices.length > 0) {
            cookerId = devices[0].cookerId;
            ovenType = devices[0].type || "oven_v1";
            console.log(`Anova discovered: cookerId=${cookerId}, type=${ovenType}`);
          }
        }

        if (msg.command === "EVENT_APO_STATE" && msg.payload) {
          const state = msg.payload.state || msg.payload;
          const fwVersion = state?.systemInfo?.firmwareVersion || null;
          const resolvedCookerId = cookerId || msg.payload.cookerId || "unknown";
          clearTimeout(timeout);
          resolve({ ws, cookerId: resolvedCookerId, ovenType, state, firmwareVersion: fwVersion });
        }
      } catch (err) {
        console.error("Anova message parse error:", err);
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection failed"));
    };

    ws.onclose = (event: CloseEvent) => {
      clearTimeout(timeout);
      if (!cookerId) {
        reject(new Error(`WebSocket closed before state received (code: ${event.code})`));
      }
    };
  });
}

/**
 * Send a command and wait for acknowledgment.
 */
function sendCommand(ws: WebSocket, command: any, timeoutMs = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    const requestId = command.requestId;
    const timeout = setTimeout(() => {
      resolve({ status: "timeout", message: "Command sent but no acknowledgment received" });
    }, timeoutMs);

    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : "{}");
        if (msg.command === "RESPONSE" && msg.requestId === requestId) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          resolve(msg);
        }
        // Also resolve on processedCommandIds containing our requestId
        if (msg.processedCommandIds && Array.isArray(msg.processedCommandIds)) {
          if (msg.processedCommandIds.includes(requestId)) {
            clearTimeout(timeout);
            ws.removeEventListener("message", handler);
            resolve({ status: "ok", processedCommandIds: msg.processedCommandIds });
          }
        }
      } catch {}
    };

    ws.addEventListener("message", handler);
    ws.send(JSON.stringify(command));
    console.log(`Anova command sent: ${command.command}`);
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

    // Allow service role key for internal calls (PAI, etc.)
    const token = authHeader.replace("Bearer ", "");
    let appUser: any = null;
    let checkPermission: (key: string) => Promise<boolean>;

    if (token === supabaseServiceKey) {
      appUser = { id: "service", role: "oracle" };
      checkPermission = async () => true;
    } else {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return jsonResponse({ error: "Invalid token" }, 401);
      }

      const permResult = await getAppUserWithPermission(supabase, user.id, "view_oven");
      appUser = permResult.appUser;
      if (!permResult.hasPermission) {
        return jsonResponse({ error: "Insufficient permissions" }, 403);
      }

      checkPermission = async (key: string) => {
        if (key === "view_oven") return true; // already checked
        const r = await getAppUserWithPermission(supabase, user.id, key);
        return r.hasPermission;
      };
    }

    // 2. Parse request
    const body: AnovaControlRequest = await req.json();

    // 3. Load config
    const { data: config } = await supabase
      .from("anova_config")
      .select("*")
      .eq("id", 1)
      .single();

    if (!config?.pat) {
      return jsonResponse({ error: "Anova PAT not configured. Add it in Appliances > Settings." }, 400);
    }

    if (!config.is_active) {
      return jsonResponse({ error: "Anova integration is disabled" }, 400);
    }

    if (config.test_mode) {
      return jsonResponse({ test_mode: true, message: "Test mode — no API call made" });
    }

    // ---- GET STATUS ----
    if (body.action === "getStatus") {
      let connection;
      try {
        connection = await connectAnova(config.ws_url, config.pat);
      } catch (err) {
        // Update last_error
        await supabase
          .from("anova_config")
          .update({ last_error: err.message, updated_at: new Date().toISOString() })
          .eq("id", 1);
        return jsonResponse({ error: `Failed to connect to oven: ${err.message}` }, 502);
      }

      const { ws, cookerId, ovenType, state, firmwareVersion } = connection;
      try { ws.close(); } catch {}

      // Upsert oven into anova_ovens (auto-discovery)
      const now = new Date().toISOString();
      const { data: existing } = await supabase
        .from("anova_ovens")
        .select("id")
        .eq("cooker_id", cookerId)
        .maybeSingle();

      if (existing) {
        await supabase
          .from("anova_ovens")
          .update({
            last_state: state,
            last_synced_at: now,
            oven_type: ovenType,
            firmware_version: firmwareVersion,
            updated_at: now,
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("anova_ovens").insert({
          cooker_id: cookerId,
          name: "Anova Precision Oven",
          oven_type: ovenType,
          firmware_version: firmwareVersion,
          last_state: state,
          last_synced_at: now,
        });
      }

      // Clear last_error on success
      await supabase
        .from("anova_config")
        .update({ last_error: null, last_synced_at: now, updated_at: now })
        .eq("id", 1);

      // Log API usage
      supabase.from("api_usage_log").insert({
        vendor: "anova",
        category: "anova_oven_poll",
        endpoint: "getStatus",
        units: 1,
        unit_type: "websocket_connections",
        estimated_cost_usd: 0,
        metadata: { cooker_id: cookerId, oven_type: ovenType },
        app_user_id: appUser?.id !== "service" ? appUser?.id : null,
      }).then(() => {}).catch(() => {});

      return jsonResponse({ state, cookerId, ovenType, firmwareVersion });
    }

    // ---- START COOK ----
    if (body.action === "startCook") {
      if (!(await checkPermission("control_oven"))) {
        return jsonResponse({ error: "Insufficient permissions to control oven" }, 403);
      }

      if (!body.stages || body.stages.length === 0) {
        return jsonResponse({ error: "Missing stages for startCook" }, 400);
      }

      let connection;
      try {
        connection = await connectAnova(config.ws_url, config.pat);
      } catch (err) {
        return jsonResponse({ error: `Failed to connect: ${err.message}` }, 502);
      }

      const { ws, cookerId, ovenType } = connection;

      const requestId = crypto.randomUUID();
      const command = {
        command: "CMD_APO_START",
        requestId,
        payload: {
          id: cookerId,
          type: "CMD_APO_START",
          payload: {
            cookId: crypto.randomUUID(),
            stages: body.stages,
            cookerId,
            type: ovenType,
            originSource: "api",
          },
        },
      };

      const result = await sendCommand(ws, command);
      try { ws.close(); } catch {}

      // Log API usage
      supabase.from("api_usage_log").insert({
        vendor: "anova",
        category: "anova_oven_control",
        endpoint: "startCook",
        units: 1,
        unit_type: "websocket_connections",
        estimated_cost_usd: 0,
        metadata: { cooker_id: cookerId, stages_count: body.stages.length },
        app_user_id: appUser?.id !== "service" ? appUser?.id : null,
      }).then(() => {}).catch(() => {});

      return jsonResponse({ success: true, result });
    }

    // ---- STOP COOK ----
    if (body.action === "stopCook") {
      if (!(await checkPermission("control_oven"))) {
        return jsonResponse({ error: "Insufficient permissions to control oven" }, 403);
      }

      let connection;
      try {
        connection = await connectAnova(config.ws_url, config.pat);
      } catch (err) {
        return jsonResponse({ error: `Failed to connect: ${err.message}` }, 502);
      }

      const { ws, cookerId } = connection;

      const requestId = crypto.randomUUID();
      const command = {
        command: "CMD_APO_STOP",
        requestId,
        payload: {
          id: cookerId,
          type: "CMD_APO_STOP",
        },
      };

      const result = await sendCommand(ws, command);
      try { ws.close(); } catch {}

      // Log API usage
      supabase.from("api_usage_log").insert({
        vendor: "anova",
        category: "anova_oven_control",
        endpoint: "stopCook",
        units: 1,
        unit_type: "websocket_connections",
        estimated_cost_usd: 0,
        metadata: { cooker_id: cookerId },
        app_user_id: appUser?.id !== "service" ? appUser?.id : null,
      }).then(() => {}).catch(() => {});

      return jsonResponse({ success: true, result });
    }

    // ---- SET TEMPERATURE UNIT ----
    if (body.action === "setTemperatureUnit") {
      if (!(await checkPermission("control_oven"))) {
        return jsonResponse({ error: "Insufficient permissions to control oven" }, 403);
      }

      const unit = body.temperatureUnit || "F";

      let connection;
      try {
        connection = await connectAnova(config.ws_url, config.pat);
      } catch (err) {
        return jsonResponse({ error: `Failed to connect: ${err.message}` }, 502);
      }

      const { ws, cookerId } = connection;

      const requestId = crypto.randomUUID();
      const command = {
        command: "CMD_APO_SET_TEMPERATURE_UNIT",
        requestId,
        payload: {
          id: cookerId,
          type: "CMD_APO_SET_TEMPERATURE_UNIT",
          payload: { temperatureUnit: unit },
        },
      };

      const result = await sendCommand(ws, command);
      try { ws.close(); } catch {}

      return jsonResponse({ success: true, unit, result });
    }

    return jsonResponse({ error: `Unknown action: ${body.action}` }, 400);
  } catch (error) {
    console.error("Anova control error:", error.message);
    return jsonResponse({ error: error.message }, 500);
  }
});
