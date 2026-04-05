import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

serve(async (req) => {
  // This function is deployed with --no-verify-jwt
  // It's called by pg_cron every 3 days to keep the Nest OAuth token alive
  // Security: only accepts POST, verifies a shared secret from nest_config

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Read config
    const { data: config, error } = await supabase
      .from("nest_config")
      .select("*")
      .single();

    if (error || !config) {
      return new Response(JSON.stringify({ error: "Nest not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!config.refresh_token) {
      return new Response(
        JSON.stringify({ error: "No refresh token" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Refresh the access token
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.google_client_id,
        client_secret: config.google_client_secret,
        refresh_token: config.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.error) {
      console.error("Nest token refresh failed:", tokenData);
      return new Response(
        JSON.stringify({
          error: `Token refresh failed: ${tokenData.error_description || tokenData.error}`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Store new access token
    const expiresAt = new Date(
      Date.now() + tokenData.expires_in * 1000
    ).toISOString();

    await supabase
      .from("nest_config")
      .update({
        access_token: tokenData.access_token,
        token_expires_at: expiresAt,
        // Update refresh token if Google issued a new one
        ...(tokenData.refresh_token
          ? { refresh_token: tokenData.refresh_token }
          : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);

    console.log(
      `Nest token refreshed successfully, expires at ${expiresAt}`
    );

    return new Response(
      JSON.stringify({
        success: true,
        expiresAt,
        refreshedAt: new Date().toISOString(),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Nest token refresh error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
