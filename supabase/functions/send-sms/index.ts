import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// SMS template types
type SmsType =
  | "payment_reminder"
  | "payment_overdue"
  | "payment_received"
  | "deposit_requested"
  | "deposit_received"
  | "lease_sent"
  | "lease_signed"
  | "move_in_confirmed"
  | "general"
  | "bulk_announcement";

interface SmsRequest {
  type: SmsType;
  to: string;
  data: Record<string, any>;
  person_id?: string;
}

interface TelnyxConfig {
  api_key: string;
  messaging_profile_id: string;
  phone_number: string;
  is_active: boolean;
  test_mode: boolean;
}

// SMS template generator - short messages for each type
function getSmsBody(type: SmsType, data: Record<string, any>): string {
  switch (type) {
    case "payment_reminder":
      return `Hi ${data.first_name}, friendly reminder: your ${data.period || 'rent'} of $${data.amount} is due ${data.due_date}. Pay via Venmo @PropertyPlayhouse or Zelle admin@YOUR_DOMAIN - YOUR_PROPERTY_NAME`;

    case "payment_overdue":
      return `Hi ${data.first_name}, your rent of $${data.amount} was due ${data.due_date} and is ${data.days_overdue} day(s) overdue.${data.late_fee ? ` Late fee: $${data.late_fee}. Total: $${data.total_due}.` : ''} Please pay ASAP. - YOUR_PROPERTY_NAME`;

    case "payment_received":
      return `Hi ${data.first_name}, we received your $${data.amount} payment${data.period ? ` for ${data.period}` : ''}. Thank you! - YOUR_PROPERTY_NAME`;

    case "deposit_requested":
      return `Hi ${data.first_name}, your deposit of $${data.total_due} is due${data.due_date ? ` by ${data.due_date}` : ''}. Pay via Venmo @PropertyPlayhouse or Zelle admin@YOUR_DOMAIN - YOUR_PROPERTY_NAME`;

    case "deposit_received":
      return `Hi ${data.first_name}, we received your $${data.amount} deposit.${data.remaining_balance > 0 ? ` Remaining: $${data.remaining_balance}.` : ' All deposits received!'} Thank you! - YOUR_PROPERTY_NAME`;

    case "lease_sent":
      return `Hi ${data.first_name}, your lease agreement has been sent for e-signature. Please check your email from SignWell and sign at your earliest convenience. - YOUR_PROPERTY_NAME`;

    case "lease_signed":
      return `Hi ${data.first_name}, your lease has been signed! Next: submit your deposits. Details sent via email. - YOUR_PROPERTY_NAME`;

    case "move_in_confirmed":
      return `Hi ${data.first_name}, welcome to YOUR_PROPERTY_NAME! Your move-in is confirmed for ${data.move_in_date}. Rent of $${data.monthly_rate} is due the 1st of each month. - YOUR_PROPERTY_NAME`;

    case "general":
      return data.message || data.body || "";

    case "bulk_announcement":
      return data.message || data.body || "";

    default:
      throw new Error(`Unknown SMS type: ${type}`);
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Parse request
    const body: SmsRequest = await req.json();
    const { type, to, data, person_id } = body;

    if (!type || !to || !data) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: type, to, data" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Load Telnyx config from database
    const { data: config, error: configError } = await supabase
      .from("telnyx_config")
      .select("*")
      .single();

    if (configError || !config) {
      console.error("Telnyx config not found:", configError);
      return new Response(
        JSON.stringify({ error: "Telnyx not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const telnyxConfig = config as TelnyxConfig;

    if (!telnyxConfig.is_active) {
      return new Response(
        JSON.stringify({ error: "Telnyx SMS is disabled" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!telnyxConfig.phone_number) {
      return new Response(
        JSON.stringify({ error: "Telnyx phone number not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate message body from template
    const messageBody = getSmsBody(type, data);

    if (!messageBody) {
      return new Response(
        JSON.stringify({ error: "Empty message body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Test mode: log but don't send
    if (telnyxConfig.test_mode) {
      console.log("TEST MODE - SMS not sent:", { type, to, body: messageBody });

      // Log to sms_messages table
      await supabase.from("sms_messages").insert({
        person_id: person_id || null,
        direction: "outbound",
        from_number: telnyxConfig.phone_number,
        to_number: to,
        body: messageBody,
        sms_type: type,
        telnyx_id: `TEST_${Date.now()}`,
        status: "test",
      });

      return new Response(
        JSON.stringify({ success: true, id: `TEST_${Date.now()}`, test_mode: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Send via Telnyx API v2
    const telnyxUrl = "https://api.telnyx.com/v2/messages";

    const telnyxPayload: Record<string, any> = {
      from: telnyxConfig.phone_number,
      to,
      text: messageBody,
      type: "SMS",
    };

    // Include messaging profile ID if configured
    if (telnyxConfig.messaging_profile_id) {
      telnyxPayload.messaging_profile_id = telnyxConfig.messaging_profile_id;
    }

    const telnyxResponse = await fetch(telnyxUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${telnyxConfig.api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(telnyxPayload),
    });

    const telnyxResult = await telnyxResponse.json();

    if (!telnyxResponse.ok) {
      console.error("Telnyx API error:", telnyxResult);

      // Log failed message
      await supabase.from("sms_messages").insert({
        person_id: person_id || null,
        direction: "outbound",
        from_number: telnyxConfig.phone_number,
        to_number: to,
        body: messageBody,
        sms_type: type,
        status: "failed",
        error_code: telnyxResult.errors?.[0]?.code?.toString() || "",
        error_message: telnyxResult.errors?.[0]?.detail || telnyxResult.errors?.[0]?.title || "Telnyx API error",
      });

      return new Response(
        JSON.stringify({ error: "Failed to send SMS", details: telnyxResult }),
        { status: telnyxResponse.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const messageId = telnyxResult.data?.id || "";

    // Log successful message
    await supabase.from("sms_messages").insert({
      person_id: person_id || null,
      direction: "outbound",
      from_number: telnyxConfig.phone_number,
      to_number: to,
      body: messageBody,
      sms_type: type,
      telnyx_id: messageId,
      status: telnyxResult.data?.to?.[0]?.status || "queued",
    });

    console.log("SMS sent successfully:", { type, to, id: messageId });

    // Log to api_usage_log (fire-and-forget)
    supabase.from("api_usage_log").insert({
      vendor: "telnyx",
      category: `sms_${type}`,
      endpoint: "POST /messages",
      units: 1,
      unit_type: "sms_segments",
      estimated_cost_usd: 0.004,
      metadata: { telnyx_id: messageId, sms_type: type, to },
    }).then(() => {});

    return new Response(
      JSON.stringify({ success: true, id: messageId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error:", error.message);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
