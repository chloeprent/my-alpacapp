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
 * Vapi Server URL handler.
 *
 * When a call comes in, Vapi sends an "assistant-request" message to this URL.
 * We return a full assistant configuration with the prompt from our database,
 * optionally personalized based on the caller's phone number.
 *
 * This lets us manage prompts in Supabase instead of the Vapi dashboard.
 */
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

    console.log("Vapi server URL request:", messageType);

    // Only handle assistant-request messages
    if (messageType !== "assistant-request") {
      // Forward other message types (function-call, etc.) with empty response
      return jsonResponse({});
    }

    // Extract caller info
    const callerPhone =
      body.message?.call?.customer?.number ||
      body.call?.customer?.number ||
      null;

    console.log("Incoming call from:", callerPhone);

    // Check if voice system is active
    const { data: config } = await supabase
      .from("vapi_config")
      .select("*")
      .eq("id", 1)
      .single();

    if (!config?.is_active) {
      console.log("Voice system is disabled");
      return jsonResponse({ error: "Voice system is disabled" }, 503);
    }

    // Load the default active assistant
    const { data: assistant, error: assistantError } = await supabase
      .from("voice_assistants")
      .select("*")
      .eq("is_active", true)
      .eq("is_default", true)
      .limit(1)
      .single();

    if (assistantError || !assistant) {
      // Fallback: get any active assistant
      const { data: fallback } = await supabase
        .from("voice_assistants")
        .select("*")
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .single();

      if (!fallback) {
        console.error("No active voice assistant configured");
        return jsonResponse(
          { error: "No voice assistant configured" },
          503
        );
      }

      const availInfo = await getSpaceAvailability(supabase);
      return jsonResponse(buildAssistantConfig(fallback, callerPhone, null, null, null, availInfo));
    }

    // Try to identify the caller
    let callerName: string | null = null;
    let callerGreeting: string | null = null;
    let callerType: string | null = null;
    if (callerPhone) {
      const digits = callerPhone.replace(/\D/g, "");
      const last10 = digits.slice(-10);

      if (last10.length === 10) {
        const { data: people } = await supabase
          .from("people")
          .select("id, first_name, last_name, phone, phone2, voice_greeting, type")
          .not("phone", "is", null);

        if (people) {
          for (const person of people) {
            const phone1Last10 = person.phone ? person.phone.replace(/\D/g, "").slice(-10) : "";
            const phone2Last10 = person.phone2 ? person.phone2.replace(/\D/g, "").slice(-10) : "";
            if (phone1Last10 === last10 || phone2Last10 === last10) {
              callerName =
                `${person.first_name || ""} ${person.last_name || ""}`.trim();
              callerGreeting = person.voice_greeting || null;
              callerType = person.type || null;
              console.log(`Identified caller: ${callerName} (${callerType})`);
              break;
            }
          }
        }
      }
    }

    // Load live space availability for the prompt
    const availabilityInfo = await getSpaceAvailability(supabase);

    const assistantConfig = buildAssistantConfig(
      assistant,
      callerPhone,
      callerName,
      callerGreeting,
      callerType,
      availabilityInfo
    );

    // In test mode, add a note to the system prompt
    if (config.test_mode) {
      assistantConfig.assistant.model.messages[0].content +=
        "\n\n[TEST MODE: This is a test call. Mention that this is a test if asked.]";
      console.log("Test mode: added test notice to prompt");
    }

    return jsonResponse(assistantConfig);
  } catch (error) {
    console.error("Vapi server URL error:", error.message);
    return jsonResponse({ error: error.message }, 500);
  }
});

/**
 * Build the Vapi assistant configuration from our DB assistant record.
 */
function buildAssistantConfig(
  assistant: any,
  callerPhone: string | null,
  callerName: string | null,
  callerGreeting: string | null,
  callerType: string | null,
  availabilityInfo: string
) {
  // Personalize the prompt if we know the caller
  let systemPrompt = assistant.system_prompt;
  if (callerName) {
    const roleLabel = callerType === 'staff' ? 'staff member' :
                      callerType === 'tenant' ? 'resident' :
                      callerType === 'airbnb_guest' ? 'guest' :
                      callerType === 'prospect' ? 'prospective resident' :
                      callerType === 'associate' ? 'associate' :
                      'contact';
    systemPrompt += `\n\nThe caller has been identified as ${callerName} (${roleLabel}).`;

    // Role-based permissions for smart home control
    if (callerType === 'staff') {
      systemPrompt += `\nAs staff/admin, ${callerName} has FULL access to all smart home controls — lights, thermostats, music, vehicles, everything in every area. Help them with any request.`;
    } else if (callerType === 'tenant') {
      systemPrompt += `\nAs a resident, ${callerName} can control smart home features in common areas (Kitchen, Living Room, Front Porch, Back Yard, Garage Mahal). They cannot control devices in other residents' private spaces. Help them with common area requests.`;
    } else if (callerType === 'associate') {
      systemPrompt += `\nAs an associate, ${callerName} is a trusted friend of the property. They can ask about the property, spaces, and availability. They don't have smart home access but should be treated warmly and given helpful information.`;
    } else if (callerType === 'airbnb_guest') {
      systemPrompt += `\nAs a guest, ${callerName} does NOT have access to smart home controls. If they ask about lights, thermostats, or music, politely let them know those features are available through the resident portal and suggest they contact the property manager for help.`;
    } else {
      systemPrompt += `\nThis caller does not have smart home access. Focus on answering property questions and directing them to team@YOUR_DOMAIN for further help.`;
    }
  } else {
    // Unknown caller
    systemPrompt += `\n\nThis is an unknown caller. They do not have smart home access. Focus on answering property questions, and if they are interested in renting, collect their name and contact info and let them know the property manager will follow up.`;
  }

  // Inject live availability data
  if (availabilityInfo) {
    systemPrompt += `\n\n${availabilityInfo}`;
  }

  // Personalize the greeting
  let firstMessage = assistant.first_message;
  if (callerName && callerGreeting) {
    // Custom per-person greeting
    firstMessage = `Hey ${callerName.split(" ")[0]}! ${callerGreeting}`;
  } else if (callerName) {
    // Insert name into the default first message after "Greetings"
    firstMessage = firstMessage.replace('Greetings!', `Greetings ${callerName.split(" ")[0]}!`);
  }

  // Map model provider to Vapi model config
  const modelConfig: any = {
    provider: assistant.model_provider === "google" ? "google" : "openai",
    model: assistant.model_name,
    temperature: parseFloat(assistant.temperature) || 0.7,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
    ],
  };

  // Build voice config
  const voiceConfig: any = {
    provider: assistant.voice_provider || "11labs",
    voiceId: assistant.voice_id || "sarah",
  };

  return {
    assistant: {
      model: modelConfig,
      voice: voiceConfig,
      firstMessage: firstMessage,
      maxDurationSeconds: assistant.max_duration_seconds || 600,
      // Enable transcription and recording
      transcriber: {
        provider: assistant.transcriber_provider || "deepgram",
        model: assistant.transcriber_model || "nova-2",
        language: assistant.transcriber_language || "en",
      },
      // Analysis settings for end-of-call
      analysisPlan: {
        summaryPrompt:
          "Summarize the call in 2-3 sentences. Include what the caller wanted and the outcome.",
      },
      // Silence and end-of-speech detection
      silenceTimeoutSeconds: 30,
      responseDelaySeconds: 0.5,
      ...(assistant.metadata || {}),
    },
  };
}

/**
 * Query live space availability from the database.
 * Returns a text summary for injection into the system prompt.
 */
async function getSpaceAvailability(supabase: any): Promise<string> {
  try {
    // Get listed dwelling spaces
    const { data: spaces } = await supabase
      .from("spaces")
      .select("id, name, monthly_rate, weekly_rate, nightly_rate, beds, baths, type, square_feet")
      .eq("can_be_dwelling", true)
      .eq("is_listed", true)
      .eq("is_archived", false)
      .order("monthly_rate", { ascending: false });

    if (!spaces || spaces.length === 0) {
      return "AVAILABILITY: No spaces are currently listed.";
    }

    // Get active assignments to determine occupancy
    const { data: assignments } = await supabase
      .from("assignments")
      .select("id, start_date, end_date, desired_departure_date, desired_departure_listed, status, assignment_spaces(space_id)")
      .in("status", ["active", "pending_contract", "contract_sent"]);

    const today = new Date();
    const lines: string[] = ["CURRENT SPACE AVAILABILITY (live data):"];

    for (const space of spaces) {
      const spaceAssignments = (assignments || []).filter((a: any) =>
        a.assignment_spaces?.some((as: any) => as.space_id === space.id)
      );

      const currentAssignment = spaceAssignments.find((a: any) => {
        if (a.status !== "active") return false;
        const effectiveEnd = (a.desired_departure_listed && a.desired_departure_date) || a.end_date;
        if (!effectiveEnd) return true;
        return new Date(effectiveEnd) >= today;
      });

      const isAvailable = !currentAssignment;
      let availStr = "Available NOW";
      if (!isAvailable) {
        const effectiveEnd = (currentAssignment.desired_departure_listed && currentAssignment.desired_departure_date) || currentAssignment.end_date;
        availStr = effectiveEnd ? `Available ${new Date(effectiveEnd).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Available TBD";
      }

      const rate = space.monthly_rate ? `$${space.monthly_rate}/mo` : space.weekly_rate ? `$${space.weekly_rate}/wk` : space.nightly_rate ? `$${space.nightly_rate}/night` : "Contact for pricing";
      const details = [
        space.beds ? `${space.beds} bed` : null,
        space.baths ? `${space.baths} bath` : null,
        space.square_feet ? `${space.square_feet} sqft` : null,
      ].filter(Boolean).join(", ");

      lines.push(`- ${space.name}: ${availStr} | ${rate}${details ? ` | ${details}` : ""}`);
    }

    return lines.join("\n");
  } catch (err) {
    console.error("Failed to load availability:", err);
    return "";
  }
}
