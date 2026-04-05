import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CONTEXT_URL = `${SUPABASE_URL}/storage/v1/object/public/site-content/context.json`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ContextData {
  spaces?: Array<{
    name: string;
    description?: string;
    type?: string;
    monthly_rate?: number;
    beds?: number;
    baths?: number;
  }>;
  faq?: Array<{
    question: string;
    answer: string;
  }>;
  external_content?: Array<{
    title: string;
    content: string;
  }>;
}

function buildContextPrompt(contextData: ContextData): string {
  const parts: string[] = [];

  // Add general info
  parts.push(`GENERAL INFO:
- Location: 123 Main Stive, Your City, TX 00000 (30 minutes east of Austin)
- Contact: team@YOUR_DOMAIN
- Website: YOUR_DOMAIN`);

  // Add spaces info
  if (contextData.spaces?.length) {
    parts.push('\nAVAILABLE RENTAL SPACES:');
    contextData.spaces.forEach(space => {
      let desc = `- ${space.name}`;
      if (space.type) desc += ` (${space.type})`;
      if (space.monthly_rate) desc += `: $${space.monthly_rate}/month`;
      if (space.beds || space.baths) {
        const details: string[] = [];
        if (space.beds) details.push(`${space.beds} bed`);
        if (space.baths) details.push(`${space.baths} bath`);
        desc += ` - ${details.join(', ')}`;
      }
      if (space.description) desc += `\n  ${space.description}`;
      parts.push(desc);
    });
  }

  // Add FAQ
  if (contextData.faq?.length) {
    parts.push('\nFREQUENTLY ASKED QUESTIONS:');
    contextData.faq.forEach(faq => {
      parts.push(`Q: ${faq.question}\nA: ${faq.answer}\n`);
    });
  }

  // Add external content
  if (contextData.external_content?.length) {
    contextData.external_content.forEach(doc => {
      parts.push(`\n${doc.title.toUpperCase()}:\n${doc.content}`);
    });
  }

  return parts.join('\n');
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY not configured");
    }

    console.log("GEMINI_API_KEY prefix:", GEMINI_API_KEY.substring(0, 10) + "...");

    const { question } = await req.json();
    console.log("Question received:", question);

    if (!question?.trim()) {
      return new Response(
        JSON.stringify({ error: "Please enter a question" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Load context
    let contextData: ContextData = { spaces: [], faq: [], external_content: [] };
    try {
      const contextResponse = await fetch(CONTEXT_URL);
      if (contextResponse.ok) {
        contextData = await contextResponse.json();
      }
    } catch (e) {
      console.warn("Failed to load context:", e);
    }

    const contextPrompt = buildContextPrompt(contextData);

    const systemPrompt = `You are a helpful assistant for YOUR_PROPERTY_NAME, a unique property in Your City, Texas (near Austin) that offers rental spaces, event hosting, and community experiences. You help answer questions from visitors, potential renters, and event hosts.

IMPORTANT INSTRUCTIONS:
1. Answer based ONLY on the context provided below. If you're not sure or the information isn't in the context, say so honestly.
2. Be friendly, concise, and helpful.
3. At the end of your response, include a confidence assessment in this exact format on a new line:
   CONFIDENCE: HIGH (if you're very confident the answer is accurate based on context)
   CONFIDENCE: LOW (if you're unsure, making assumptions, or the context doesn't cover this topic)
4. For rental inquiries, mention they can apply at https://YOUR_DOMAIN/spaces/apply/
5. For event hosting, mention they can apply at https://YOUR_DOMAIN/events/
6. Keep responses under 200 words unless more detail is needed.
7. If someone asks you to PERFORM AN ACTION (turn on/off lights, play music, control thermostats, lock/unlock cars, etc.), politely explain that you can only answer questions — you cannot control devices or take actions. If they are a current resident, suggest they use the resident portal at https://YOUR_DOMAIN/residents/ for smart home controls.
8. If a question is completely unrelated to YOUR_PROPERTY_NAME (e.g. general trivia, coding help, personal advice), politely redirect and say you're here to help with questions about YOUR_PROPERTY_NAME.

CONTEXT ABOUT ALPACA PLAYHOUSE:
${contextPrompt}

---

Now answer the following question from a visitor:`;

    // Call Gemini API with retry on rate limit
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
    const geminiBody = JSON.stringify({
      contents: [{
        parts: [
          { text: systemPrompt },
          { text: question }
        ]
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 500,
      }
    });

    let geminiResponse: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      geminiResponse = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: geminiBody
      });

      console.log(`Gemini attempt ${attempt + 1}: status=${geminiResponse.status}`);
      if (geminiResponse.ok || geminiResponse.status !== 429) break;

      // Rate limited — wait and retry
      console.warn(`Gemini rate limited (attempt ${attempt + 1}), retrying...`);
      await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
    }

    if (!geminiResponse || !geminiResponse.ok) {
      const errorData = geminiResponse ? await geminiResponse.json() : {};
      console.error("Gemini API error:", JSON.stringify(errorData));
      const errorMsg = errorData?.error?.message || "Failed to get a response from AI";
      throw new Error(errorMsg);
    }

    const data = await geminiResponse.json();
    const rawAnswer = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log("Gemini response received, confident:", rawAnswer.includes("CONFIDENCE: HIGH"));

    // Parse confidence from response
    const confidenceMatch = rawAnswer.match(/CONFIDENCE:\s*(HIGH|LOW)/i);
    const confident = confidenceMatch ? confidenceMatch[1].toUpperCase() === "HIGH" : false;

    // Remove the confidence line from the displayed answer
    const answer = rawAnswer.replace(/\n?CONFIDENCE:\s*(HIGH|LOW)/i, "").trim();

    // Log question + answer to faq_entries for admin visibility
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/faq_entries`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Prefer": "return=minimal"
        },
        body: JSON.stringify({
          question: question.trim(),
          ai_answer: answer,
          confidence: confident ? "HIGH" : "LOW",
          source: "auto",
          is_published: false
        })
      });
    } catch (logError) {
      console.warn("Failed to log question:", logError);
      // Don't fail the response if logging fails
    }

    return new Response(
      JSON.stringify({ answer, confident }),
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
