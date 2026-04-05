import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

type AlexaRequestEnvelope = {
  version: string;
  context?: {
    System?: {
      device?: {
        deviceId?: string;
      };
    };
  };
  session?: {
    application?: { applicationId?: string };
  };
  request?: {
    type?: string;
    intent?: {
      name?: string;
      slots?: Record<string, { name: string; value?: string }>;
    };
  };
};

type RoomTarget = {
  room_key: string;
  room_name: string;
  wiz_ips: string[] | null;
  govee_group_ids: string[] | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function alexaResponse(text: string, endSession = true) {
  return new Response(
    JSON.stringify({
      version: "1.0",
      response: {
        outputSpeech: {
          type: "PlainText",
          text,
        },
        shouldEndSession: endSession,
      },
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

function normalizeRoomName(input?: string) {
  if (!input) return "";
  const value = input.trim().toLowerCase();
  if (
    value.includes("master pasture") ||
    value.includes("masture pasture") ||
    value.includes("master bedroom") ||
    value.includes("pasture bedroom")
  ) {
    return "master_pasture";
  }
  return value.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function callGoveeControl(
  supabaseUrl: string,
  serviceRoleKey: string,
  deviceId: string,
  on?: boolean,
  brightness?: number,
  colorRgb?: number,
) {
  let capability: Record<string, unknown>;
  if (colorRgb != null) {
    capability = {
      type: "devices.capabilities.color_setting",
      instance: "colorRgb",
      value: colorRgb,
    };
  } else if (on == null) {
    capability = {
      type: "devices.capabilities.range",
      instance: "brightness",
      value: brightness,
    };
  } else {
    capability = {
      type: "devices.capabilities.on_off",
      instance: "powerSwitch",
      value: on ? 1 : 0,
    };
  }

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

  if (!resp.ok) {
    const details = await resp.text().catch(() => "");
    throw new Error(`govee-control failed (${resp.status}): ${details}`);
  }
}

async function callWizProxy(
  ips: string[],
  power?: boolean,
  brightness?: number,
  color?: { r: number; g: number; b: number },
) {
  const wizProxyUrl = Deno.env.get("WIZ_PROXY_URL") || "";
  const wizProxyToken = Deno.env.get("WIZ_PROXY_TOKEN") || "";
  if (!wizProxyUrl || !wizProxyToken) {
    throw new Error("WIZ_PROXY_URL/WIZ_PROXY_TOKEN not configured");
  }

  const endpoint = color ? "color" : power == null ? "brightness" : "power";
  const resp = await fetch(`${wizProxyUrl.replace(/\/+$/, "")}/group/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${wizProxyToken}`,
    },
    body: JSON.stringify({
      ips,
      ...(color
        ? { r: color.r, g: color.g, b: color.b, dimming: 70 }
        : power == null
          ? { brightness }
          : { on: power }),
    }),
  });

  if (!resp.ok) {
    const details = await resp.text().catch(() => "");
    throw new Error(`wiz-proxy failed (${resp.status}): ${details}`);
  }
  const result = await resp.json().catch(() => ({}));
  const rows = Array.isArray(result?.results) ? result.results : [];
  const failedIps = rows
    .filter((r: any) => !r?.ok && r?.ip)
    .map((r: any) => String(r.ip));

  // Retry failed bulbs once — UDP can be lossy.
  if (failedIps.length > 0) {
    const retryResp = await fetch(`${wizProxyUrl.replace(/\/+$/, "")}/group/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${wizProxyToken}`,
      },
      body: JSON.stringify({
        ips: failedIps,
        ...(color
          ? { r: color.r, g: color.g, b: color.b, dimming: 70 }
          : power == null
            ? { brightness }
            : { on: power }),
      }),
    });
    if (retryResp.ok) {
      const retryResult = await retryResp.json().catch(() => ({}));
      const retryRows = Array.isArray(retryResult?.results) ? retryResult.results : [];
      const retryByIp = new Map(retryRows.map((r: any) => [String(r.ip), r]));
      for (let i = 0; i < rows.length; i++) {
        const ip = String(rows[i]?.ip || "");
        if (!ip || rows[i]?.ok) continue;
        const rr = retryByIp.get(ip);
        if (rr?.ok) rows[i] = rr;
      }
    }
  }

  const okCount = rows.filter((r: any) => r?.ok).length;
  return {
    total: rows.length || ips.length,
    okCount,
    failedCount: Math.max(0, (rows.length || ips.length) - okCount),
    results: rows,
  };
}

function parseNamedColorToRgbInt(value: string): number | null {
  const map: Record<string, number> = {
    red: 0xff0000,
    green: 0x00ff00,
    blue: 0x0000ff,
    orange: 0xff6600,
    purple: 0x8800ff,
    pink: 0xff69b4,
    yellow: 0xffff00,
    white: 0xffffff,
    warm: 0xffd4a3,
    "warm white": 0xffd4a3,
    cool: 0xe8f0ff,
    "cool white": 0xe8f0ff,
  };
  const key = value.trim().toLowerCase();
  if (map[key] != null) return map[key];
  const hex = key.match(/^#?([0-9a-f]{6})$/i);
  if (hex) return parseInt(hex[1], 16);
  return null;
}

function rgbIntToParts(rgb: number): { r: number; g: number; b: number } {
  return {
    r: (rgb >> 16) & 255,
    g: (rgb >> 8) & 255,
    b: rgb & 255,
  };
}

function envList(name: string) {
  return (Deno.env.get(name) || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

async function lookupRoomByDevice(
  supabase: any,
  alexaDeviceId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("alexa_device_room_map")
    .select("room_key")
    .eq("alexa_device_id", alexaDeviceId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    console.error("lookupRoomByDevice error:", error.message);
    return null;
  }
  return data?.room_key || null;
}

async function getRoomTarget(
  supabase: any,
  roomKey: string,
): Promise<RoomTarget | null> {
  const { data, error } = await supabase
    .from("alexa_room_targets")
    .select("room_key, room_name, wiz_ips, govee_group_ids")
    .eq("room_key", roomKey)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    console.error("getRoomTarget error:", error.message);
    return null;
  }
  return data ?? null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const body = await req.json() as AlexaRequestEnvelope;
    const skillId = Deno.env.get("ALEXA_SKILL_ID") || "";

    if (skillId) {
      const appId = body?.session?.application?.applicationId || "";
      if (appId && appId !== skillId) {
        return alexaResponse("Skill ID mismatch.");
      }
    }

    const requestType = body?.request?.type || "";
    if (requestType === "LaunchRequest") {
      return alexaResponse(
        "Property Home is ready. You can say turn master pasture lights on.",
      );
    }

    if (requestType !== "IntentRequest") {
      return alexaResponse("Unsupported request type.");
    }

    const intentName = body?.request?.intent?.name || "";
    const alexaDeviceId = body?.context?.System?.device?.deviceId || "";
    const roomSlot = body?.request?.intent?.slots?.room?.value;
    const requestedRoomKey = normalizeRoomName(roomSlot);
    if (alexaDeviceId) {
      console.log("Alexa request deviceId:", alexaDeviceId);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Missing required Supabase env vars.");
      return alexaResponse("Configuration error.");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let roomKey = requestedRoomKey;
    if (!roomKey && alexaDeviceId) {
      roomKey = (await lookupRoomByDevice(supabase, alexaDeviceId)) || "";
    }
    if (!roomKey) roomKey = "master_pasture";

    let roomTarget = await getRoomTarget(supabase, roomKey);
    if (!roomTarget && roomKey === "master_pasture") {
      roomTarget = {
        room_key: "master_pasture",
        room_name: "Master Pasture",
        wiz_ips: envList("ALEXA_MASTER_PASTURE_WIZ_IPS"),
        govee_group_ids: envList("ALEXA_MASTER_PASTURE_GROUP_IDS"),
      };
    }
    if (!roomTarget) {
      return alexaResponse(
        alexaDeviceId
          ? "This Echo is not mapped to a room yet."
          : "I could not determine which room to control.",
      );
    }

    const roomName = roomTarget.room_name || roomTarget.room_key;
    const wizIps = (roomTarget.wiz_ips || []).filter(Boolean);
    const groupIds = (roomTarget.govee_group_ids || []).filter(Boolean);

    if (intentName === "TurnLightsOnIntent") {
      if (wizIps.length > 0) {
        const wizResult = await callWizProxy(wizIps, true);
        return alexaResponse(`${roomName} lights are on (${wizResult.okCount}/${wizResult.total}).`);
      }
      if (groupIds.length > 0) {
        for (const groupId of groupIds) {
          await callGoveeControl(supabaseUrl, serviceRoleKey, groupId, true);
        }
        return alexaResponse(`${roomName} lights are on.`);
      }
      console.error(`No WiZ IPs or Govee group IDs configured for ${roomKey}.`);
      return alexaResponse(`${roomName} lights are not configured yet.`);
    }

    if (intentName === "TurnLightsOffIntent") {
      if (wizIps.length > 0) {
        const wizResult = await callWizProxy(wizIps, false);
        return alexaResponse(`${roomName} lights are off (${wizResult.okCount}/${wizResult.total}).`);
      }
      if (groupIds.length > 0) {
        for (const groupId of groupIds) {
          await callGoveeControl(supabaseUrl, serviceRoleKey, groupId, false);
        }
        return alexaResponse(`${roomName} lights are off.`);
      }
      console.error(`No WiZ IPs or Govee group IDs configured for ${roomKey}.`);
      return alexaResponse(`${roomName} lights are not configured yet.`);
    }

    if (intentName === "SetBrightnessIntent") {
      const raw = body?.request?.intent?.slots?.brightness?.value || "";
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
        return alexaResponse("Please give a brightness between 1 and 100.");
      }
      if (wizIps.length > 0) {
        const wizResult = await callWizProxy(wizIps, undefined, parsed);
        return alexaResponse(`Set ${roomName} lights to ${parsed} percent (${wizResult.okCount}/${wizResult.total}).`);
      }
      if (groupIds.length > 0) {
        for (const groupId of groupIds) {
          await callGoveeControl(
            supabaseUrl,
            serviceRoleKey,
            groupId,
            undefined,
            parsed,
          );
        }
        return alexaResponse(`Set ${roomName} lights to ${parsed} percent.`);
      }
      console.error(`No WiZ IPs or Govee group IDs configured for ${roomKey}.`);
      return alexaResponse(`${roomName} lights are not configured yet.`);
    }

    if (intentName === "SetColorIntent") {
      const rawColor = body?.request?.intent?.slots?.color?.value || "";
      const rgbInt = parseNamedColorToRgbInt(rawColor);
      if (rgbInt == null) {
        return alexaResponse("I couldn't parse that color. Try a basic color like red, blue, or warm white.");
      }
      const rgb = rgbIntToParts(rgbInt);
      if (wizIps.length > 0) {
        const wizResult = await callWizProxy(wizIps, undefined, undefined, rgb);
        if (groupIds.length === 0) {
          return alexaResponse(`Set ${roomName} lights to ${rawColor} (${wizResult.okCount}/${wizResult.total}).`);
        }
      }
      if (groupIds.length > 0) {
        for (const groupId of groupIds) {
          await callGoveeControl(supabaseUrl, serviceRoleKey, groupId, undefined, undefined, rgbInt);
        }
      }
      if (wizIps.length === 0 && groupIds.length === 0) {
        console.error(`No WiZ IPs or Govee group IDs configured for ${roomKey}.`);
        return alexaResponse(`${roomName} lights are not configured yet.`);
      }
      return alexaResponse(`Set ${roomName} lights to ${rawColor}.`);
    }

    if (intentName === "AMAZON.HelpIntent") {
      return alexaResponse(
        "Try saying, turn master pasture lights on, or turn master pasture lights off.",
      );
    }

    return alexaResponse("I do not support that command yet.");
  } catch (error) {
    console.error("alexa-room-control error:", error);
    return alexaResponse("Sorry, I hit an error controlling the lights.");
  }
});
