import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

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
 * Normalize a phone number and try to match it to a person in the DB.
 */
async function matchCallerToPersonId(
  supabase: any,
  phone: string
): Promise<{ personId: string | null; personName: string | null }> {
  if (!phone) return { personId: null, personName: null };

  const digits = phone.replace(/\D/g, "");
  const last10 = digits.slice(-10);
  if (last10.length < 10) return { personId: null, personName: null };

  const { data: people } = await supabase
    .from("people")
    .select("id, first_name, last_name, phone")
    .not("phone", "is", null);

  if (!people) return { personId: null, personName: null };

  for (const person of people) {
    if (!person.phone) continue;
    const personLast10 = person.phone.replace(/\D/g, "").slice(-10);
    if (personLast10 === last10 && personLast10.length === 10) {
      return {
        personId: person.id,
        personName:
          `${person.first_name || ""} ${person.last_name || ""}`.trim(),
      };
    }
  }

  return { personId: null, personName: null };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const body = await req.json();
    const messageType = body.message?.type || body.type;

    console.log("Vapi webhook received:", messageType);

    // Handle different Vapi webhook event types
    switch (messageType) {
      // ---- Call lifecycle events ----
      case "status-update": {
        const status = body.message?.status || body.status;
        const callId = body.message?.call?.id || body.call?.id;
        const callerPhone =
          body.message?.call?.customer?.number ||
          body.call?.customer?.number ||
          null;

        console.log(`Call ${callId}: status=${status}, caller=${callerPhone}`);

        if (!callId) break;

        if (status === "ringing" || status === "in-progress") {
          // Match caller to a person
          const { personId, personName } = await matchCallerToPersonId(
            supabase,
            callerPhone
          );
          if (personName) {
            console.log(`Matched caller to: ${personName} (${personId})`);
          }

          // Find assistant ID from the call data
          const vapiAssistantId =
            body.message?.call?.assistantId || body.call?.assistantId;
          let dbAssistantId: string | null = null;
          if (vapiAssistantId) {
            // Look up by metadata if we stored the vapi assistant ID
            const { data: assistant } = await supabase
              .from("voice_assistants")
              .select("id")
              .eq("is_default", true)
              .eq("is_active", true)
              .limit(1)
              .single();
            dbAssistantId = assistant?.id || null;
          }

          // Upsert call record
          await supabase.from("voice_calls").upsert(
            {
              vapi_call_id: callId,
              assistant_id: dbAssistantId,
              caller_phone: callerPhone,
              person_id: personId,
              status: status === "ringing" ? "ringing" : "in-progress",
              started_at:
                status === "in-progress" ? new Date().toISOString() : undefined,
              metadata: {
                vapi_assistant_id: vapiAssistantId,
              },
            },
            { onConflict: "vapi_call_id" }
          );
        } else if (status === "ended") {
          // Update call with end data
          const callData = body.message?.call || body.call || {};
          const endedReason =
            body.message?.endedReason || callData.endedReason || "unknown";
          const startedAt = callData.startedAt;
          const endedAt = callData.endedAt;

          let durationSeconds: number | null = null;
          if (startedAt && endedAt) {
            durationSeconds = Math.round(
              (new Date(endedAt).getTime() - new Date(startedAt).getTime()) /
                1000
            );
          }

          // Extract cost if available
          const costCents = callData.cost
            ? Math.round(callData.cost * 100)
            : null;

          // Extract transcript
          const transcript = callData.messages || callData.transcript || null;

          // Extract summary
          const summary = callData.analysis?.summary || null;

          await supabase
            .from("voice_calls")
            .update({
              status: "ended",
              ended_at: endedAt || new Date().toISOString(),
              started_at: startedAt || undefined,
              duration_seconds: durationSeconds,
              cost_cents: costCents,
              transcript: transcript,
              summary: summary,
              recording_url: callData.recordingUrl || null,
              ended_reason: endedReason,
            })
            .eq("vapi_call_id", callId);

          console.log(
            `Call ${callId} ended: duration=${durationSeconds}s, reason=${endedReason}`
          );
        }
        break;
      }

      // ---- End of call report (detailed) ----
      case "end-of-call-report": {
        const callId = body.message?.call?.id || body.call?.id;
        const report = body.message || body;

        if (!callId) break;

        const callData = report.call || {};
        const startedAt = callData.startedAt;
        const endedAt = callData.endedAt;

        let durationSeconds: number | null = null;
        if (startedAt && endedAt) {
          durationSeconds = Math.round(
            (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000
          );
        }

        const costCents = callData.cost
          ? Math.round(callData.cost * 100)
          : null;

        await supabase
          .from("voice_calls")
          .update({
            status: "ended",
            ended_at: endedAt || new Date().toISOString(),
            started_at: startedAt || undefined,
            duration_seconds: durationSeconds,
            cost_cents: costCents,
            transcript: report.transcript || callData.messages || null,
            summary: report.summary || report.analysis?.summary || null,
            recording_url: report.recordingUrl || callData.recordingUrl || null,
            ended_reason:
              report.endedReason || callData.endedReason || "completed",
          })
          .eq("vapi_call_id", callId);

        console.log(
          `End-of-call report for ${callId}: duration=${durationSeconds}s, cost=$${(costCents || 0) / 100}`
        );
        break;
      }

      // ---- Transcript updates (real-time) ----
      case "transcript": {
        // Optional: store partial transcripts for live monitoring
        const callId = body.message?.call?.id || body.call?.id;
        const role = body.message?.role || "unknown";
        const text = body.message?.transcript || "";
        console.log(`Transcript [${callId}] ${role}: ${text.substring(0, 80)}`);
        break;
      }

      // ---- Hang notification ----
      case "hang": {
        const callId = body.message?.call?.id || body.call?.id;
        console.log(`Hang detected for call ${callId}`);
        break;
      }

      default:
        console.log(
          `Unhandled Vapi webhook type: ${messageType}`,
          JSON.stringify(body).substring(0, 300)
        );
    }

    // Always return 200 to prevent Vapi retries
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error("Vapi webhook error:", error.message);
    return jsonResponse({ ok: true }, 200);
  }
});
