import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VALID_SECTIONS = ["pronunciation", "greetings", "phrases", "byc", "miec", "jechac", "isc"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const section = url.searchParams.get("section");

    if (!section || !VALID_SECTIONS.includes(section)) {
      return new Response(
        JSON.stringify({
          error: "Invalid section",
          valid: VALID_SECTIONS,
          usage: "GET /lesson-nav?section=greetings",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Broadcast to the lesson page via Supabase Realtime
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const channel = supabase.channel("polish-lesson-1");

    // Must subscribe before sending — wait for SUBSCRIBED status
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Channel subscribe timeout"));
      }, 5000);
      channel.subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timeout);
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(timeout);
          reject(new Error(`Channel error: ${status}`));
        }
      });
    });

    await channel.send({
      type: "broadcast",
      event: "navigate",
      payload: { section },
    });

    // Clean up channel
    await supabase.removeChannel(channel);

    return new Response(
      JSON.stringify({ ok: true, section, message: `Navigated to ${section}` }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("lesson-nav error:", e.message);
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
