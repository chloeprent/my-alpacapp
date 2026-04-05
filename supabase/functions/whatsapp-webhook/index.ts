import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
};

/**
 * Verify WhatsApp webhook signature using HMAC SHA256.
 * Meta signs the payload with the app secret.
 */
async function verifySignature(
  rawBody: string,
  signature: string,
  appSecret: string
): Promise<boolean> {
  try {
    if (!signature.startsWith("sha256=")) return false;
    const expectedSig = signature.slice(7); // Remove "sha256=" prefix

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(appSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
    const hexSig = Array.from(new Uint8Array(signed))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return hexSig === expectedSig;
  } catch (error) {
    console.error("Signature verification error:", error.message);
    return false;
  }
}

/**
 * Match a phone number to a person in the database.
 * Uses fuzzy last-10-digits matching (same as telnyx-webhook).
 */
async function matchPerson(
  supabase: any,
  phone: string
): Promise<{ id: string; name: string } | null> {
  const { data: people } = await supabase
    .from("people")
    .select("id, first_name, last_name, phone")
    .not("phone", "is", null);

  if (!people) return null;

  const fromDigits = phone.replace(/\D/g, "");
  const fromLast10 = fromDigits.slice(-10);

  for (const person of people) {
    if (!person.phone) continue;
    const personDigits = person.phone.replace(/\D/g, "");
    const personLast10 = personDigits.slice(-10);

    if (personLast10 === fromLast10 && personLast10.length === 10) {
      return {
        id: person.id,
        name: `${person.first_name || ""} ${person.last_name || ""}`.trim(),
      };
    }
  }

  return null;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // ===== GET: Webhook Verification =====
  // Meta sends a GET request to verify the webhook URL
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token) {
      // Load verify token from config
      const { data: config } = await supabase
        .from("whatsapp_config")
        .select("verify_token")
        .single();

      if (config && token === config.verify_token) {
        console.log("Webhook verification successful");
        return new Response(challenge || "", { status: 200 });
      } else {
        console.error("Webhook verification failed: token mismatch");
        return new Response("Verification failed", { status: 403 });
      }
    }

    return new Response("OK", { status: 200 });
  }

  // ===== POST: Incoming Messages & Status Updates =====
  try {
    const rawBody = await req.text();

    // Verify signature if app_secret is configured
    const signature = req.headers.get("x-hub-signature-256") || "";
    if (signature) {
      const { data: config } = await supabase
        .from("whatsapp_config")
        .select("app_secret")
        .single();

      if (config?.app_secret) {
        const isValid = await verifySignature(rawBody, signature, config.app_secret);
        if (!isValid) {
          console.error("Invalid webhook signature - rejecting");
          return new Response(JSON.stringify({ error: "Invalid signature" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }
        console.log("Webhook signature verified");
      }
    }

    const webhook = JSON.parse(rawBody);

    // WhatsApp webhook structure:
    // { object: "whatsapp_business_account", entry: [{ id, changes: [{ value: { ... }, field }] }] }
    if (webhook.object !== "whatsapp_business_account") {
      console.log("Ignoring non-WhatsApp webhook:", webhook.object);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    for (const entry of webhook.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;

        // Handle incoming messages
        if (value.messages) {
          for (const message of value.messages) {
            await handleInboundMessage(supabase, value, message);
          }
        }

        // Handle delivery status updates
        if (value.statuses) {
          for (const status of value.statuses) {
            await handleStatusUpdate(supabase, status);
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Webhook error:", error.message);

    // Always return 200 to prevent Meta retries
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});

/**
 * Handle an inbound WhatsApp message.
 */
async function handleInboundMessage(
  supabase: any,
  value: any,
  message: any
): Promise<void> {
  const from = message.from || ""; // Sender phone (digits only)
  const waId = message.id || "";
  const timestamp = message.timestamp || "";

  // Get our phone number from metadata
  const ourPhone = value.metadata?.display_phone_number || "";

  // Extract message body based on type
  let body = "";
  let mediaUrls: string[] = [];
  let numMedia = 0;

  switch (message.type) {
    case "text":
      body = message.text?.body || "";
      break;
    case "image":
      body = message.image?.caption || "[Image]";
      mediaUrls.push(message.image?.id || "");
      numMedia = 1;
      break;
    case "video":
      body = message.video?.caption || "[Video]";
      numMedia = 1;
      break;
    case "audio":
      body = "[Audio message]";
      numMedia = 1;
      break;
    case "document":
      body = message.document?.caption || `[Document: ${message.document?.filename || "file"}]`;
      numMedia = 1;
      break;
    case "location":
      body = `[Location: ${message.location?.latitude}, ${message.location?.longitude}]`;
      break;
    case "contacts":
      body = "[Contact shared]";
      break;
    case "reaction":
      body = `[Reaction: ${message.reaction?.emoji || ""}]`;
      break;
    case "sticker":
      body = "[Sticker]";
      numMedia = 1;
      break;
    default:
      body = `[${message.type || "unknown"} message]`;
  }

  // Format sender phone for lookup (add + prefix)
  const fromFormatted = from.startsWith("+") ? from : `+${from}`;

  console.log("Inbound WhatsApp:", {
    from: fromFormatted,
    body: body.substring(0, 50),
    waId,
  });

  // Match to person
  const person = await matchPerson(supabase, fromFormatted);
  if (person) {
    console.log(`Matched WhatsApp message to person: ${person.name} (${person.id})`);
  } else {
    console.log(`No person match for WhatsApp phone: ${fromFormatted}`);
  }

  // Store inbound message
  const { error: insertError } = await supabase.from("sms_messages").insert({
    person_id: person?.id || null,
    direction: "inbound",
    from_number: fromFormatted,
    to_number: ourPhone,
    body: body,
    telnyx_id: waId, // reusing telnyx_id column for WA message ID
    status: "received",
    sms_type: "inbound",
    channel: "whatsapp",
    num_media: numMedia,
    media_urls: mediaUrls.length > 0 ? mediaUrls : null,
  });

  if (insertError) {
    console.error("Error storing inbound WhatsApp message:", insertError);
  }
}

/**
 * Handle a WhatsApp message delivery status update.
 */
async function handleStatusUpdate(
  supabase: any,
  status: any
): Promise<void> {
  const waMessageId = status.id || "";
  const statusValue = status.status || ""; // sent, delivered, read, failed
  const recipientId = status.recipient_id || "";

  console.log("WhatsApp status update:", { waMessageId, status: statusValue });

  // Update the message status in our database
  if (waMessageId && statusValue) {
    const { error } = await supabase
      .from("sms_messages")
      .update({ status: statusValue })
      .eq("telnyx_id", waMessageId)
      .eq("channel", "whatsapp");

    if (error) {
      console.error("Error updating WhatsApp message status:", error);
    }
  }

  // Log errors
  if (statusValue === "failed" && status.errors) {
    for (const err of status.errors) {
      console.error("WhatsApp delivery error:", {
        code: err.code,
        title: err.title,
        message: err.message,
        recipient: recipientId,
      });
    }
  }
}
