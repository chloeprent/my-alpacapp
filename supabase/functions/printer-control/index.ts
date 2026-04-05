import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getAppUserWithPermission } from "../_shared/permissions.ts";

interface PrinterControlRequest {
  action:
    | "getStatus"
    | "startPrint"
    | "pausePrint"
    | "resumePrint"
    | "cancelPrint"
    | "setTemperature"
    | "toggleLight"
    | "homeAxes"
    | "listFiles"
    | "uploadFile"
    | "uploadLocalFile";
  printerId?: string;
  filename?: string;
  target?: "nozzle" | "bed";
  tempC?: number;
  on?: boolean;
  gcode?: string; // base64-encoded gcode for uploadFile
  localPath?: string; // local filesystem path for uploadLocalFile
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

/**
 * Call the printer proxy running on Property Mac (via Caddy/Tailscale).
 */
async function callPrinterProxy(
  proxyUrl: string,
  proxySecret: string,
  route: string,
  payload: any,
): Promise<any> {
  const url = proxyUrl.replace(/\/$/, "");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${proxySecret}`,
    },
    body: JSON.stringify({ action: route, ...payload }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Proxy request failed" }));
    throw new Error(err.error || `Proxy error ${response.status}`);
  }
  return response.json();
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

    // Check for service role key - try both env var AND JWT role check
    const isServiceRole = token === supabaseServiceKey || (() => {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.role === 'service_role';
      } catch { return false; }
    })();

    if (isServiceRole) {
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

      const permResult = await getAppUserWithPermission(supabase, user.id, "view_printer");
      appUser = permResult.appUser;
      if (!permResult.hasPermission) {
        return jsonResponse({ error: "Insufficient permissions" }, 403);
      }

      checkPermission = async (key: string) => {
        if (key === "view_printer") return true; // already checked
        const r = await getAppUserWithPermission(supabase, user.id, key);
        return r.hasPermission;
      };
    }

    // 2. Parse request
    const body: PrinterControlRequest = await req.json();

    // 3. Load config
    const { data: config } = await supabase
      .from("printer_config")
      .select("*")
      .eq("id", 1)
      .single();

    if (!config?.proxy_url) {
      return jsonResponse(
        { error: "Printer proxy URL not configured. Add it in Appliances > Settings." },
        400,
      );
    }

    if (!config.is_active) {
      return jsonResponse({ error: "Printer integration is disabled" }, 400);
    }

    if (config.test_mode) {
      return jsonResponse({ test_mode: true, message: "Test mode — no API call made" });
    }

    const proxyUrl = config.proxy_url;
    const proxySecret = config.proxy_secret || "";

    // 4. Resolve printer
    let printer: any = null;
    if (body.printerId) {
      const { data } = await supabase
        .from("printer_devices")
        .select("*")
        .eq("id", body.printerId)
        .eq("is_active", true)
        .single();
      printer = data;
    } else {
      // Default to first active printer
      const { data } = await supabase
        .from("printer_devices")
        .select("*")
        .eq("is_active", true)
        .order("display_order", { ascending: true })
        .limit(1)
        .single();
      printer = data;
    }

    if (!printer) {
      return jsonResponse({ error: "No active printer found" }, 404);
    }

    const printerIp = printer.lan_ip;
    const printerPort = printer.tcp_port || 8899;
    const now = new Date().toISOString();

    // ---- GET STATUS ----
    if (body.action === "getStatus") {
      let result;
      try {
        result = await callPrinterProxy(proxyUrl, proxySecret, "status", {
          ip: printerIp,
          port: printerPort,
        });
      } catch (err) {
        await supabase
          .from("printer_config")
          .update({ last_error: err.message, updated_at: now })
          .eq("id", 1);
        return jsonResponse({ error: `Failed to reach printer: ${err.message}` }, 502);
      }

      // Cache state in printer_devices
      await supabase
        .from("printer_devices")
        .update({
          last_state: result,
          last_synced_at: now,
          machine_type: result.machineType || printer.machine_type,
          firmware_version: result.firmwareVersion || printer.firmware_version,
          updated_at: now,
        })
        .eq("id", printer.id);

      // Clear last_error on success
      await supabase
        .from("printer_config")
        .update({ last_error: null, last_synced_at: now, updated_at: now })
        .eq("id", 1);

      // Log API usage (fire-and-forget)
      supabase
        .from("api_usage_log")
        .insert({
          vendor: "flashforge",
          category: "printer_status_poll",
          endpoint: "getStatus",
          units: 1,
          unit_type: "api_calls",
          estimated_cost_usd: 0,
          metadata: { printer_id: printer.id, printer_name: printer.name },
          app_user_id: appUser?.id !== "service" ? appUser?.id : null,
        })
        .then(() => {})
        .catch(() => {});

      return jsonResponse({ state: result, printerId: printer.id });
    }

    // ---- CONTROL ACTIONS (require control_printer permission) ----
    const controlActions = [
      "startPrint",
      "pausePrint",
      "resumePrint",
      "cancelPrint",
      "setTemperature",
      "toggleLight",
      "homeAxes",
    ];

    if (controlActions.includes(body.action)) {
      if (!(await checkPermission("control_printer"))) {
        return jsonResponse({ error: "Insufficient permissions to control printer" }, 403);
      }
    }

    // ---- START PRINT ----
    if (body.action === "startPrint") {
      if (!body.filename) {
        return jsonResponse({ error: "Missing filename" }, 400);
      }

      const result = await callPrinterProxy(proxyUrl, proxySecret, "control", {
        ip: printerIp,
        port: printerPort,
        commands: [`~M23 /data/${body.filename}`, "~M24"],
      });

      logUsage(supabase, "printer_control", "startPrint", printer, appUser);
      return jsonResponse({ success: true, result });
    }

    // ---- PAUSE PRINT ----
    if (body.action === "pausePrint") {
      const result = await callPrinterProxy(proxyUrl, proxySecret, "control", {
        ip: printerIp,
        port: printerPort,
        commands: ["~M25"],
      });

      logUsage(supabase, "printer_control", "pausePrint", printer, appUser);
      return jsonResponse({ success: true, result });
    }

    // ---- RESUME PRINT ----
    if (body.action === "resumePrint") {
      const result = await callPrinterProxy(proxyUrl, proxySecret, "control", {
        ip: printerIp,
        port: printerPort,
        commands: ["~M24"],
      });

      logUsage(supabase, "printer_control", "resumePrint", printer, appUser);
      return jsonResponse({ success: true, result });
    }

    // ---- CANCEL PRINT ----
    if (body.action === "cancelPrint") {
      const result = await callPrinterProxy(proxyUrl, proxySecret, "control", {
        ip: printerIp,
        port: printerPort,
        commands: ["~M26"],
      });

      logUsage(supabase, "printer_control", "cancelPrint", printer, appUser);
      return jsonResponse({ success: true, result });
    }

    // ---- SET TEMPERATURE ----
    if (body.action === "setTemperature") {
      const target = body.target || "nozzle";
      const tempC = body.tempC ?? 0;

      // M104 = nozzle, M140 = bed
      const gcode = target === "bed" ? `~M140 S${tempC}` : `~M104 S${tempC}`;

      const result = await callPrinterProxy(proxyUrl, proxySecret, "control", {
        ip: printerIp,
        port: printerPort,
        commands: [gcode],
      });

      logUsage(supabase, "printer_control", "setTemperature", printer, appUser);
      return jsonResponse({ success: true, target, tempC, result });
    }

    // ---- TOGGLE LIGHT ----
    if (body.action === "toggleLight") {
      const on = body.on ?? true;
      // M146 r{val} g{val} b{val} F0 — 255=on, 0=off
      const val = on ? 255 : 0;
      const gcode = `~M146 r${val} g${val} b${val} F0`;

      const result = await callPrinterProxy(proxyUrl, proxySecret, "control", {
        ip: printerIp,
        port: printerPort,
        commands: [gcode],
      });

      logUsage(supabase, "printer_control", "toggleLight", printer, appUser);
      return jsonResponse({ success: true, on, result });
    }

    // ---- HOME AXES ----
    if (body.action === "homeAxes") {
      const result = await callPrinterProxy(proxyUrl, proxySecret, "control", {
        ip: printerIp,
        port: printerPort,
        commands: ["~G28"],
      });

      logUsage(supabase, "printer_control", "homeAxes", printer, appUser);
      return jsonResponse({ success: true, result });
    }

    // ---- LIST FILES ----
    if (body.action === "listFiles") {
      const result = await callPrinterProxy(proxyUrl, proxySecret, "command", {
        ip: printerIp,
        port: printerPort,
        command: "~M661",
      });

      logUsage(supabase, "printer_status_poll", "listFiles", printer, appUser);
      return jsonResponse({ files: parseFileList(result.response), raw: result });
    }

    // ---- UPLOAD FILE (base64 gcode from client) ----
    if (body.action === "uploadFile") {
      if (!(await checkPermission("control_printer"))) {
        return jsonResponse({ error: "Insufficient permissions to upload files" }, 403);
      }

      if (!body.filename || !body.gcode) {
        return jsonResponse({ error: "Missing filename or gcode (base64)" }, 400);
      }

      const result = await callPrinterProxy(proxyUrl, proxySecret, "upload", {
        ip: printerIp,
        filename: body.filename,
        gcode: body.gcode,
        serialNumber: printer.serial_number || "",
        checkCode: config.check_code || "",
      });

      logUsage(supabase, "printer_control", "uploadFile", printer, appUser);
      return jsonResponse({ success: true, result });
    }

    // ---- UPLOAD LOCAL FILE (file already on Property Mac) ----
    if (body.action === "uploadLocalFile") {
      if (!(await checkPermission("control_printer"))) {
        return jsonResponse({ error: "Insufficient permissions to upload files" }, 403);
      }

      if (!body.localPath) {
        return jsonResponse({ error: "Missing localPath" }, 400);
      }

      const result = await callPrinterProxy(proxyUrl, proxySecret, "upload-local", {
        ip: printerIp,
        localPath: body.localPath,
        serialNumber: printer.serial_number || "",
        checkCode: config.check_code || "",
      });

      logUsage(supabase, "printer_control", "uploadLocalFile", printer, appUser);
      return jsonResponse({ success: true, result });
    }

    return jsonResponse({ error: `Unknown action: ${body.action}` }, 400);
  } catch (error) {
    console.error("Printer control error:", error.message);
    return jsonResponse({ error: error.message }, 500);
  }
});

/**
 * Parse M661 file list response into structured array.
 * Adventurer 5M Pro returns binary response with paths like /data/file.gcode
 * separated by :: and binary bytes. Older models return text "Begin file list".
 */
function parseFileList(raw: string): string[] {
  if (!raw) return [];

  // Try text format first (older FlashForge models)
  if (raw.includes("Begin file list")) {
    const lines = raw.split("\n");
    const files: string[] = [];
    let inList = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "Begin file list") { inList = true; continue; }
      if (trimmed === "End file list" || trimmed.startsWith("ok")) break;
      if (inList && trimmed) {
        files.push(trimmed.replace(/^\/data\//, ""));
      }
    }
    return files;
  }

  // Binary format (Adventurer 5M Pro): extract /data/*.gcode paths
  const matches = raw.match(/\/data\/[^\x00-\x1f:]+\.(?:gcode|3mf|gx)/gi);
  if (matches) {
    return matches.map((f) => f.replace(/^\/data\//, ""));
  }

  return [];
}

/**
 * Fire-and-forget API usage logging.
 */
function logUsage(
  supabase: any,
  category: string,
  endpoint: string,
  printer: any,
  appUser: any,
) {
  supabase
    .from("api_usage_log")
    .insert({
      vendor: "flashforge",
      category,
      endpoint,
      units: 1,
      unit_type: "api_calls",
      estimated_cost_usd: 0,
      metadata: { printer_id: printer.id, printer_name: printer.name },
      app_user_id: appUser?.id !== "service" ? appUser?.id : null,
    })
    .then(() => {})
    .catch(() => {});
}
