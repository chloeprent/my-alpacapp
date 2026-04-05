import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// Message types (same as SMS)
type MessageType =
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

interface WhatsAppRequest {
  type: MessageType;
  to: string;
  data: Record<string, any>;
  person_id?: string;
}

interface WhatsAppConfig {
  access_token: string;
  phone_number_id: string;
  waba_id: string;
  phone_number: string;
  is_active: boolean;
  test_mode: boolean;
}

/**
 * Build a WhatsApp template message payload.
 * For types with approved templates, uses template format.
 * For general/bulk messages within 24h window, uses text format.
 */
function buildMessagePayload(
  type: MessageType,
  to: string,
  data: Record<string, any>
): Record<string, any> {
  // Normalize phone to WhatsApp format (digits only, no +)
  const waPhone = to.replace(/\D/g, "");

  // For general messages, use free-form text (only works within 24h window)
  if (type === "general" || type === "bulk_announcement") {
    const text = data.message || data.body || "";
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: waPhone,
      type: "text",
      text: { body: text },
    };
  }

  // For structured notifications, use template messages
  const templateMapping = getTemplateMapping(type, data);

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: waPhone,
    type: "template",
    template: {
      name: templateMapping.name,
      language: { code: "en_US" },
      components: templateMapping.components,
    },
  };
}

/**
 * Map message types to WhatsApp template names and parameters.
 * Templates must be pre-approved in WhatsApp Manager.
 */
function getTemplateMapping(
  type: MessageType,
  data: Record<string, any>
): { name: string; components: any[] } {
  switch (type) {
    case "payment_reminder":
      return {
        name: "payment_reminder",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: data.first_name || "there" },
              { type: "text", text: data.period || "rent" },
              { type: "text", text: `$${data.amount}` },
              { type: "text", text: data.due_date || "soon" },
            ],
          },
        ],
      };

    case "payment_overdue":
      return {
        name: "payment_overdue",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: data.first_name || "there" },
              { type: "text", text: `$${data.amount}` },
              { type: "text", text: data.due_date || "" },
              { type: "text", text: `${data.days_overdue || 0}` },
              { type: "text", text: data.late_fee ? `$${data.total_due}` : `$${data.amount}` },
            ],
          },
        ],
      };

    case "payment_received":
      return {
        name: "payment_received",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: data.first_name || "there" },
              { type: "text", text: `$${data.amount}` },
              { type: "text", text: data.period || "" },
            ],
          },
        ],
      };

    case "deposit_requested":
      return {
        name: "deposit_requested",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: data.first_name || "there" },
              { type: "text", text: `$${data.total_due}` },
              { type: "text", text: data.due_date || "as soon as possible" },
            ],
          },
        ],
      };

    case "deposit_received":
      return {
        name: "deposit_received",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: data.first_name || "there" },
              { type: "text", text: `$${data.amount}` },
              {
                type: "text",
                text: data.remaining_balance > 0
                  ? `Remaining: $${data.remaining_balance}.`
                  : "All deposits received!",
              },
            ],
          },
        ],
      };

    case "lease_sent":
      return {
        name: "lease_sent",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: data.first_name || "there" },
            ],
          },
        ],
      };

    case "lease_signed":
      return {
        name: "lease_signed",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: data.first_name || "there" },
            ],
          },
        ],
      };

    case "move_in_confirmed":
      return {
        name: "move_in_confirmed",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: data.first_name || "there" },
              { type: "text", text: data.move_in_date || "" },
              { type: "text", text: `$${data.monthly_rate}` },
            ],
          },
        ],
      };

    default:
      // Fallback: use a generic notification template
      return {
        name: "general_notification",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: data.message || data.body || "" },
            ],
          },
        ],
      };
  }
}

/**
 * Build a plain text fallback (used for test mode logging)
 */
function getPlainTextBody(type: MessageType, data: Record<string, any>): string {
  switch (type) {
    case "payment_reminder":
      return `Hi ${data.first_name}, friendly reminder: your ${data.period || "rent"} of $${data.amount} is due ${data.due_date}. Pay via Venmo @PropertyPlayhouse or Zelle admin@YOUR_DOMAIN - YOUR_PROPERTY_NAME`;
    case "payment_overdue":
      return `Hi ${data.first_name}, your rent of $${data.amount} was due ${data.due_date} and is ${data.days_overdue} day(s) overdue.${data.late_fee ? ` Late fee: $${data.late_fee}. Total: $${data.total_due}.` : ""} Please pay ASAP. - YOUR_PROPERTY_NAME`;
    case "payment_received":
      return `Hi ${data.first_name}, we received your $${data.amount} payment${data.period ? ` for ${data.period}` : ""}. Thank you! - YOUR_PROPERTY_NAME`;
    case "deposit_requested":
      return `Hi ${data.first_name}, your deposit of $${data.total_due} is due${data.due_date ? ` by ${data.due_date}` : ""}. Pay via Venmo @PropertyPlayhouse or Zelle admin@YOUR_DOMAIN - YOUR_PROPERTY_NAME`;
    case "deposit_received":
      return `Hi ${data.first_name}, we received your $${data.amount} deposit.${data.remaining_balance > 0 ? ` Remaining: $${data.remaining_balance}.` : " All deposits received!"} Thank you! - YOUR_PROPERTY_NAME`;
    case "lease_sent":
      return `Hi ${data.first_name}, your lease agreement has been sent for e-signature. Please check your email from SignWell. - YOUR_PROPERTY_NAME`;
    case "lease_signed":
      return `Hi ${data.first_name}, your lease has been signed! Next: submit your deposits. Details sent via email. - YOUR_PROPERTY_NAME`;
    case "move_in_confirmed":
      return `Hi ${data.first_name}, welcome to YOUR_PROPERTY_NAME! Your move-in is confirmed for ${data.move_in_date}. Rent of $${data.monthly_rate} is due the 1st of each month. - YOUR_PROPERTY_NAME`;
    case "general":
    case "bulk_announcement":
      return data.message || data.body || "";
    default:
      return data.message || "";
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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
    const body: WhatsAppRequest = await req.json();
    const { type, to, data, person_id } = body;

    if (!type || !to || !data) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: type, to, data" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Load WhatsApp config from database
    const { data: config, error: configError } = await supabase
      .from("whatsapp_config")
      .select("*")
      .single();

    if (configError || !config) {
      console.error("WhatsApp config not found:", configError);
      return new Response(
        JSON.stringify({ error: "WhatsApp not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const waConfig = config as WhatsAppConfig;

    if (!waConfig.is_active) {
      return new Response(
        JSON.stringify({ error: "WhatsApp messaging is disabled" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!waConfig.phone_number_id || !waConfig.access_token) {
      return new Response(
        JSON.stringify({ error: "WhatsApp credentials not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Build plain text for logging
    const plainText = getPlainTextBody(type, data);

    // Test mode: log but don't send
    if (waConfig.test_mode) {
      console.log("TEST MODE - WhatsApp not sent:", {
        type,
        to,
        body: plainText,
      });

      await supabase.from("sms_messages").insert({
        person_id: person_id || null,
        direction: "outbound",
        from_number: waConfig.phone_number || "whatsapp",
        to_number: to,
        body: plainText,
        sms_type: type,
        telnyx_id: `WA_TEST_${Date.now()}`,
        status: "test",
        channel: "whatsapp",
      });

      return new Response(
        JSON.stringify({
          success: true,
          id: `WA_TEST_${Date.now()}`,
          test_mode: true,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Build WhatsApp API payload
    const waPayload = buildMessagePayload(type, to, data);

    // Send via WhatsApp Cloud API
    const graphUrl = `https://graph.facebook.com/v21.0/${waConfig.phone_number_id}/messages`;

    const waResponse = await fetch(graphUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${waConfig.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(waPayload),
    });

    const waResult = await waResponse.json();

    if (!waResponse.ok) {
      console.error("WhatsApp API error:", waResult);

      // Log failed message
      await supabase.from("sms_messages").insert({
        person_id: person_id || null,
        direction: "outbound",
        from_number: waConfig.phone_number || "whatsapp",
        to_number: to,
        body: plainText,
        sms_type: type,
        status: "failed",
        channel: "whatsapp",
        error_code: waResult.error?.code?.toString() || "",
        error_message:
          waResult.error?.message || waResult.error?.error_data?.details || "WhatsApp API error",
      });

      return new Response(
        JSON.stringify({ error: "Failed to send WhatsApp message", details: waResult }),
        {
          status: waResponse.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const messageId = waResult.messages?.[0]?.id || "";

    // Log successful message
    await supabase.from("sms_messages").insert({
      person_id: person_id || null,
      direction: "outbound",
      from_number: waConfig.phone_number || "whatsapp",
      to_number: to,
      body: plainText,
      sms_type: type,
      telnyx_id: messageId, // reusing telnyx_id column for WA message ID
      status: "sent",
      channel: "whatsapp",
    });

    console.log("WhatsApp message sent:", { type, to, id: messageId });

    // Log to api_usage_log (fire-and-forget)
    // WhatsApp pricing: ~$0.015/utility conversation, ~$0.025/marketing
    const isUtility = ["payment_reminder", "payment_overdue", "payment_received",
      "deposit_requested", "deposit_received", "lease_sent", "lease_signed",
      "move_in_confirmed"].includes(type);
    const estimatedCost = isUtility ? 0.015 : 0.025;

    supabase
      .from("api_usage_log")
      .insert({
        vendor: "whatsapp",
        category: type === "bulk_announcement" ? "whatsapp_bulk_announcement" : "whatsapp_tenant_notification",
        endpoint: `POST /${waConfig.phone_number_id}/messages`,
        units: 1,
        unit_type: "conversations",
        estimated_cost_usd: estimatedCost,
        metadata: { wa_message_id: messageId, message_type: type, to },
      })
      .then(() => {});

    return new Response(
      JSON.stringify({ success: true, id: messageId }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
