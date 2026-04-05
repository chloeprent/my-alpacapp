import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getAppUserWithPermission } from "../_shared/permissions.ts";

interface GlowforgeControlRequest {
  action: "getStatus";
  machineId?: string;
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

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Authenticate with Glowforge via cookie-based login.
 * 1. GET app.glowforge.com → extract CSRF authenticity_token
 * 2. POST accounts.glowforge.com/users/sign_in with credentials
 * 3. Return session cookies
 */
async function glowforgeLogin(
  email: string,
  password: string,
): Promise<{ cookies: string; expiresAt: string }> {
  // Step 1: Get CSRF token from app.glowforge.com
  const appResp = await fetch("https://app.glowforge.com/", {
    headers: { "User-Agent": BROWSER_UA },
    redirect: "manual",
  });

  const appHtml = await appResp.text();
  const csrfMatch = appHtml.match(
    /name="authenticity_token"\s+value="([^"]+)"/,
  );
  if (!csrfMatch) {
    throw new Error("Could not extract CSRF token from Glowforge login page");
  }
  const csrfToken = csrfMatch[1];

  // Collect cookies from the initial page load
  const initCookies: string[] = [];
  for (const [key, value] of appResp.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") {
      const cookiePart = value.split(";")[0];
      initCookies.push(cookiePart);
    }
  }

  // Step 2: POST login
  const formData = new URLSearchParams({
    authenticity_token: csrfToken,
    "user[email]": email,
    "user[password]": password,
    "user[remember_me]": "1",
    commit: "Sign in",
  });

  const loginResp = await fetch(
    "https://accounts.glowforge.com/users/sign_in",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": BROWSER_UA,
        Cookie: initCookies.join("; "),
      },
      body: formData.toString(),
      redirect: "manual",
    },
  );

  // Collect all session cookies from the login response
  const allCookies: string[] = [...initCookies];
  for (const [key, value] of loginResp.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") {
      const cookiePart = value.split(";")[0];
      allCookies.push(cookiePart);
    }
  }

  // Follow redirects manually to collect cookies from each hop
  let location = loginResp.headers.get("location");
  let hops = 0;
  while (location && hops < 5) {
    const redirectResp = await fetch(location, {
      headers: {
        "User-Agent": BROWSER_UA,
        Cookie: allCookies.join("; "),
      },
      redirect: "manual",
    });
    for (const [key, value] of redirectResp.headers.entries()) {
      if (key.toLowerCase() === "set-cookie") {
        const cookiePart = value.split(";")[0];
        allCookies.push(cookiePart);
      }
    }
    location = redirectResp.headers.get("location");
    hops++;
  }

  // Deduplicate cookies (later values override earlier ones for the same name)
  const cookieMap = new Map<string, string>();
  for (const c of allCookies) {
    const eqIdx = c.indexOf("=");
    if (eqIdx > 0) {
      const name = c.substring(0, eqIdx).trim();
      cookieMap.set(name, c);
    }
  }
  const cookieStr = Array.from(cookieMap.values()).join("; ");

  // Session cookies last about 2 weeks with remember_me, set conservative expiry
  const expiresAt = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  return { cookies: cookieStr, expiresAt };
}

/**
 * Fetch machine list from Glowforge API using session cookies.
 */
async function fetchMachines(
  cookies: string,
): Promise<any[]> {
  const resp = await fetch(
    "https://api.glowforge.com/gfcore/users/machines",
    {
      headers: {
        "User-Agent": BROWSER_UA,
        Cookie: cookies,
        Accept: "application/json",
      },
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Glowforge API returned ${resp.status}: ${text.substring(0, 200)}`,
    );
  }

  const data = await resp.json();
  // The API may return an object with a machines array or directly an array
  if (Array.isArray(data)) return data;
  if (data.machines && Array.isArray(data.machines)) return data.machines;
  if (data.data && Array.isArray(data.data)) return data.data;
  // If it's a single object with machine-like properties, wrap it
  if (data.id || data.serial || data.name) return [data];
  // Return whatever we got as an array for debugging
  return Array.isArray(Object.values(data)) ? Object.values(data) : [data];
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

    if (token === supabaseServiceKey) {
      appUser = { id: "service", role: "oracle" };
    } else {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return jsonResponse({ error: "Invalid token" }, 401);
      }

      const permResult = await getAppUserWithPermission(
        supabase,
        user.id,
        "view_glowforge",
      );
      appUser = permResult.appUser;
      if (!permResult.hasPermission) {
        return jsonResponse({ error: "Insufficient permissions" }, 403);
      }
    }

    // 2. Parse request
    const body: GlowforgeControlRequest = await req.json();

    // 3. Load config
    const { data: config } = await supabase
      .from("glowforge_config")
      .select("*")
      .eq("id", 1)
      .single();

    if (!config?.is_active) {
      return jsonResponse(
        { error: "Glowforge integration is disabled" },
        400,
      );
    }

    if (config.test_mode) {
      return jsonResponse({
        test_mode: true,
        message: "Test mode — no API call made",
      });
    }

    // Get credentials from Supabase secrets
    const gfEmail = Deno.env.get("GLOWFORGE_EMAIL");
    const gfPassword = Deno.env.get("GLOWFORGE_PASSWORD");
    if (!gfEmail || !gfPassword) {
      return jsonResponse(
        {
          error:
            "Glowforge credentials not configured. Set GLOWFORGE_EMAIL and GLOWFORGE_PASSWORD secrets.",
        },
        400,
      );
    }

    // ---- GET STATUS ----
    if (body.action === "getStatus") {
      // Check if we have valid cached cookies
      let cookies = config.session_cookies;
      const expiresAt = config.session_expires_at
        ? new Date(config.session_expires_at)
        : null;
      const needsLogin =
        !cookies || !expiresAt || expiresAt.getTime() < Date.now() + 60000;

      if (needsLogin) {
        console.log("Glowforge: authenticating (no valid session)...");
        try {
          const session = await glowforgeLogin(gfEmail, gfPassword);
          cookies = session.cookies;

          // Cache the cookies in DB
          await supabase
            .from("glowforge_config")
            .update({
              session_cookies: session.cookies,
              session_expires_at: session.expiresAt,
              last_error: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", 1);
        } catch (err) {
          await supabase
            .from("glowforge_config")
            .update({
              last_error: `Login failed: ${err.message}`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", 1);
          return jsonResponse(
            { error: `Glowforge login failed: ${err.message}` },
            502,
          );
        }
      }

      // Fetch machines
      let machines: any[];
      try {
        machines = await fetchMachines(cookies);
      } catch (err) {
        // If fetch fails, try re-authenticating once
        console.log(
          "Glowforge: fetch failed, re-authenticating...",
          err.message,
        );
        try {
          const session = await glowforgeLogin(gfEmail, gfPassword);
          cookies = session.cookies;
          await supabase
            .from("glowforge_config")
            .update({
              session_cookies: session.cookies,
              session_expires_at: session.expiresAt,
              updated_at: new Date().toISOString(),
            })
            .eq("id", 1);
          machines = await fetchMachines(cookies);
        } catch (retryErr) {
          await supabase
            .from("glowforge_config")
            .update({
              last_error: `API failed after re-auth: ${retryErr.message}`,
              session_cookies: null,
              session_expires_at: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", 1);
          return jsonResponse(
            { error: `Glowforge API failed: ${retryErr.message}` },
            502,
          );
        }
      }

      // Upsert machines into glowforge_machines
      const now = new Date().toISOString();
      for (const machine of machines) {
        // Extract a stable ID — try serial, id, or name
        const machineId =
          machine.serial || machine.id?.toString() || machine.name || "unknown";
        const machineName = machine.name || "Glowforge";
        const machineType = machine.type || machine.model || null;

        const { data: existing } = await supabase
          .from("glowforge_machines")
          .select("id")
          .eq("machine_id", machineId)
          .maybeSingle();

        if (existing) {
          await supabase
            .from("glowforge_machines")
            .update({
              name: machineName,
              machine_type: machineType,
              last_state: machine,
              last_synced_at: now,
              updated_at: now,
            })
            .eq("id", existing.id);
        } else {
          await supabase.from("glowforge_machines").insert({
            machine_id: machineId,
            name: machineName,
            machine_type: machineType,
            last_state: machine,
            last_synced_at: now,
          });
        }
      }

      // Clear last_error on success
      await supabase
        .from("glowforge_config")
        .update({
          last_error: null,
          last_synced_at: now,
          updated_at: now,
        })
        .eq("id", 1);

      // Log API usage (fire-and-forget)
      supabase
        .from("api_usage_log")
        .insert({
          vendor: "glowforge",
          category: "glowforge_status_poll",
          endpoint: "gfcore/users/machines",
          units: 1,
          unit_type: "api_calls",
          estimated_cost_usd: 0,
          metadata: { machines_found: machines.length },
          app_user_id:
            appUser?.id !== "service" ? appUser?.id : null,
        })
        .then(() => {})
        .catch(() => {});

      return jsonResponse({ machines, count: machines.length });
    }

    return jsonResponse({ error: `Unknown action: ${body.action}` }, 400);
  } catch (error) {
    console.error("Glowforge control error:", error.message);
    return jsonResponse({ error: error.message }, 500);
  }
});
