import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getAppUserWithPermission } from "../_shared/permissions.ts";

type LightingAction =
  | "list_groups"
  | "list_entities"
  | "sync_entities"
  | "get_group_state"
  | "set_power"
  | "set_brightness"
  | "set_color"
  | "activate_scene";

interface LightingRequest {
  action: LightingAction;
  group_key?: string;
  group_id?: string;
  on?: boolean;
  brightness?: number;
  hex_color?: string;
  scene_entity_id?: string;
  transition?: number;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error("hex_color must be #RRGGBB");
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [r, g, b];
}

function normalizeHaBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function fetchHa(
  baseUrl: string,
  token: string,
  path: string,
  method = "GET",
  body?: any,
) {
  const resp = await fetch(`${normalizeHaBaseUrl(baseUrl)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!resp.ok) {
    throw new Error(
      `HA ${method} ${path} failed (${resp.status}): ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`,
    );
  }
  return parsed;
}

async function callWizProxy(
  wizProxyUrl: string,
  wizProxyToken: string,
  mode: "power" | "brightness" | "color",
  payload: Record<string, unknown>,
) {
  const endpoint = `${wizProxyUrl.replace(/\/+$/, "")}/group/${mode}`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${wizProxyToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(
      `wiz-proxy ${mode} failed (${resp.status}): ${JSON.stringify(result)}`,
    );
  }
  return result;
}

async function callGoveeControl(
  supabaseUrl: string,
  serviceRoleKey: string,
  deviceId: string,
  capability: Record<string, unknown>,
) {
  const resp = await fetch(`${supabaseUrl}/functions/v1/govee-control`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "controlDevice",
      device: deviceId,
      sku: "SameModeGroup",
      capability,
    }),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(
      `govee-control failed (${resp.status}): ${JSON.stringify(result)}`,
    );
  }
  return result;
}

async function callGoveeState(
  supabaseUrl: string,
  serviceRoleKey: string,
  deviceId: string,
) {
  const resp = await fetch(`${supabaseUrl}/functions/v1/govee-control`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "getDeviceState",
      device: deviceId,
      sku: "SameModeGroup",
    }),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(
      `govee-control state failed (${resp.status}): ${JSON.stringify(result)}`,
    );
  }
  return result;
}

async function getGroupWithTargets(
  supabase: any,
  reqBody: LightingRequest,
) {
  let query = supabase
    .from("lighting_groups")
    .select(
      "id, key, name, area, is_active, lighting_group_targets(id, backend, target_id, metadata, is_active)",
    )
    .eq("is_active", true);

  if (reqBody.group_key) {
    query = query.eq("key", reqBody.group_key);
  } else if (reqBody.group_id) {
    query = query.eq("id", reqBody.group_id);
  } else {
    throw new Error("group_key or group_id is required");
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Lighting group not found");
  const activeTargets = (data.lighting_group_targets || []).filter((t: any) => t.is_active);
  return { ...data, targets: activeTargets };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const token = authHeader.replace("Bearer ", "");
    const isInternalCall = token === serviceRoleKey;
    if (!isInternalCall) {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return jsonResponse({ error: "Invalid token" }, 401);
      }
      const { hasPermission } = await getAppUserWithPermission(
        supabase,
        user.id,
        "control_lighting",
      );
      if (!hasPermission) {
        return jsonResponse({ error: "Insufficient permissions" }, 403);
      }
    }

    const body = (await req.json()) as LightingRequest;
    if (!body?.action) {
      return jsonResponse({ error: "action is required" }, 400);
    }

    const { data: haConfig } = await supabase
      .from("home_assistant_config")
      .select("is_active, test_mode, use_fallbacks")
      .eq("id", 1)
      .maybeSingle();

    const haBaseUrl = Deno.env.get("HA_BASE_URL") || Deno.env.get("HOME_ASSISTANT_URL") || "";
    const haToken = Deno.env.get("HA_TOKEN") || Deno.env.get("HOME_ASSISTANT_TOKEN") || "";
    const wizProxyUrl = Deno.env.get("WIZ_PROXY_URL") || "";
    const wizProxyToken = Deno.env.get("WIZ_PROXY_TOKEN") || "";
    const useFallbacks = haConfig?.use_fallbacks !== false;
    const testMode = haConfig?.test_mode === true;
    const haActive = haConfig?.is_active !== false;

    if (body.action === "list_groups") {
      const { data, error } = await supabase
        .from("lighting_groups")
        .select(
          "id, key, name, area, display_order, lighting_group_targets(id, backend, target_id, metadata, is_active)",
        )
        .eq("is_active", true)
        .order("display_order", { ascending: true });
      if (error) throw error;
      const groups = (data || []).map((g: any) => ({
        ...g,
        lighting_group_targets: (g.lighting_group_targets || []).filter((t: any) => t.is_active),
      }));
      return jsonResponse({ groups });
    }

    if (body.action === "list_entities" || body.action === "sync_entities") {
      if (!haActive || !haBaseUrl || !haToken) {
        return jsonResponse(
          { error: "Home Assistant is not configured (HA_BASE_URL/HA_TOKEN)." },
          500,
        );
      }
      const states = await fetchHa(haBaseUrl, haToken, "/api/states");
      const entities = (states || []).filter((s: any) =>
        ["light", "switch", "scene", "group"].includes(String(s.entity_id || "").split(".")[0])
      );

      if (body.action === "sync_entities") {
        const rows = entities.map((s: any) => ({
          entity_id: s.entity_id,
          domain: String(s.entity_id || "").split(".")[0],
          friendly_name: s.attributes?.friendly_name || s.entity_id,
          area_name: s.attributes?.area || null,
          capabilities: s.attributes || {},
          is_active: true,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }));
        if (rows.length) {
          const { error } = await supabase
            .from("home_assistant_entities")
            .upsert(rows, { onConflict: "entity_id" });
          if (error) throw error;
        }
      }

      return jsonResponse({ entities, synced: body.action === "sync_entities" });
    }

    const group = await getGroupWithTargets(supabase, body);
    const targets = group.targets || [];
    if (!targets.length) {
      return jsonResponse({ error: `No active targets configured for ${group.name}` }, 400);
    }

    if (body.action === "get_group_state") {
      const perTarget: Array<Record<string, unknown>> = [];
      let onCount = 0;
      let brightnessTotal = 0;
      let brightnessCount = 0;
      for (const t of targets) {
        try {
          if (t.backend === "home_assistant") {
            if (!haBaseUrl || !haToken) throw new Error("HA not configured");
            const state = await fetchHa(
              haBaseUrl,
              haToken,
              `/api/states/${encodeURIComponent(t.target_id)}`,
            );
            const isOn = state?.state === "on";
            if (isOn) onCount += 1;
            const bri = state?.attributes?.brightness;
            if (typeof bri === "number") {
              brightnessTotal += Math.round((bri / 255) * 100);
              brightnessCount += 1;
            }
            perTarget.push({
              backend: t.backend,
              target_id: t.target_id,
              state: state?.state,
              attributes: state?.attributes || {},
            });
          } else if (t.backend === "govee_cloud" && useFallbacks) {
            const stateResp = await callGoveeState(supabaseUrl, serviceRoleKey, t.target_id);
            const caps = stateResp?.payload?.capabilities || [];
            const power = caps.find((c: any) => c.instance === "powerSwitch")?.state?.value;
            const bri = caps.find((c: any) => c.instance === "brightness")?.state?.value;
            const isOn = power === 1;
            if (isOn) onCount += 1;
            if (typeof bri === "number") {
              brightnessTotal += bri;
              brightnessCount += 1;
            }
            perTarget.push({
              backend: t.backend,
              target_id: t.target_id,
              state: isOn ? "on" : "off",
              brightness: bri ?? null,
            });
          } else {
            perTarget.push({
              backend: t.backend,
              target_id: t.target_id,
              state: "unknown",
              note: "No state adapter configured",
            });
          }
        } catch (err) {
          perTarget.push({
            backend: t.backend,
            target_id: t.target_id,
            error: (err as Error).message,
          });
        }
      }
      return jsonResponse({
        group: { id: group.id, key: group.key, name: group.name },
        state: {
          on: onCount > 0,
          brightness: brightnessCount ? Math.round(brightnessTotal / brightnessCount) : null,
        },
        per_target: perTarget,
      });
    }

    const haTargets = targets.filter((t: any) => t.backend === "home_assistant");
    const wizTargets = targets.filter((t: any) => t.backend === "wiz_proxy");
    const goveeTargets = targets.filter((t: any) => t.backend === "govee_cloud");
    const results: any[] = [];

    if (testMode) {
      return jsonResponse({
        ok: true,
        test_mode: true,
        action: body.action,
        group: { id: group.id, key: group.key, name: group.name },
        targets,
      });
    }

    if (haTargets.length) {
      if (!haActive || !haBaseUrl || !haToken) {
        return jsonResponse(
          { error: "Home Assistant targets exist but HA is not configured." },
          500,
        );
      }

      const haEntityIds = haTargets.map((t: any) => t.target_id);
      if (body.action === "set_power") {
        await fetchHa(
          haBaseUrl,
          haToken,
          `/api/services/light/${body.on ? "turn_on" : "turn_off"}`,
          "POST",
          { entity_id: haEntityIds, transition: body.transition },
        );
      } else if (body.action === "set_brightness") {
        const brightness = clampInt(Number(body.brightness || 0), 1, 100);
        await fetchHa(
          haBaseUrl,
          haToken,
          "/api/services/light/turn_on",
          "POST",
          { entity_id: haEntityIds, brightness_pct: brightness, transition: body.transition },
        );
      } else if (body.action === "set_color") {
        if (!body.hex_color) throw new Error("hex_color is required for set_color");
        const rgb = hexToRgb(body.hex_color);
        await fetchHa(
          haBaseUrl,
          haToken,
          "/api/services/light/turn_on",
          "POST",
          { entity_id: haEntityIds, rgb_color: rgb, transition: body.transition },
        );
      } else if (body.action === "activate_scene") {
        const sceneId = body.scene_entity_id ||
          haTargets.find((t: any) => String(t.target_id).startsWith("scene."))?.target_id;
        if (!sceneId) throw new Error("scene_entity_id is required for activate_scene");
        await fetchHa(
          haBaseUrl,
          haToken,
          "/api/services/scene/turn_on",
          "POST",
          { entity_id: sceneId, transition: body.transition },
        );
      } else {
        throw new Error(`Unsupported action: ${body.action}`);
      }
      results.push({ backend: "home_assistant", ok: true, count: haTargets.length });
    }

    if (wizTargets.length && useFallbacks) {
      if (!wizProxyUrl || !wizProxyToken) {
        throw new Error("WIZ fallback requested but WIZ_PROXY_URL/WIZ_PROXY_TOKEN missing");
      }
      const wizIps = wizTargets.map((t: any) => t.target_id);
      if (body.action === "set_power") {
        const result = await callWizProxy(wizProxyUrl, wizProxyToken, "power", {
          ips: wizIps,
          on: !!body.on,
        });
        results.push({ backend: "wiz_proxy", ok: true, result });
      } else if (body.action === "set_brightness") {
        const result = await callWizProxy(wizProxyUrl, wizProxyToken, "brightness", {
          ips: wizIps,
          brightness: clampInt(Number(body.brightness || 0), 1, 100),
        });
        results.push({ backend: "wiz_proxy", ok: true, result });
      } else if (body.action === "set_color") {
        if (!body.hex_color) throw new Error("hex_color is required for set_color");
        const [r, g, b] = hexToRgb(body.hex_color);
        const result = await callWizProxy(wizProxyUrl, wizProxyToken, "color", {
          ips: wizIps,
          r,
          g,
          b,
          dimming: 70,
        });
        results.push({ backend: "wiz_proxy", ok: true, result });
      }
    }

    if (goveeTargets.length && useFallbacks) {
      for (const t of goveeTargets) {
        if (body.action === "set_power") {
          await callGoveeControl(supabaseUrl, serviceRoleKey, t.target_id, {
            type: "devices.capabilities.on_off",
            instance: "powerSwitch",
            value: body.on ? 1 : 0,
          });
        } else if (body.action === "set_brightness") {
          await callGoveeControl(supabaseUrl, serviceRoleKey, t.target_id, {
            type: "devices.capabilities.range",
            instance: "brightness",
            value: clampInt(Number(body.brightness || 0), 1, 100),
          });
        } else if (body.action === "set_color") {
          if (!body.hex_color) throw new Error("hex_color is required for set_color");
          const [r, g, b] = hexToRgb(body.hex_color);
          await callGoveeControl(supabaseUrl, serviceRoleKey, t.target_id, {
            type: "devices.capabilities.color_setting",
            instance: "colorRgb",
            value: r * 65536 + g * 256 + b,
          });
        }
      }
      results.push({ backend: "govee_cloud", ok: true, count: goveeTargets.length });
    }

    return jsonResponse({
      ok: true,
      action: body.action,
      group: { id: group.id, key: group.key, name: group.name },
      results,
    });
  } catch (error) {
    console.error("home-assistant-control error:", (error as Error).message);
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
