/**
 * edit-email-template — Gemini-powered HTML email template editor
 *
 * Accepts current HTML + a natural language edit prompt,
 * returns modified HTML via Gemini 2.5 Flash.
 *
 * Auth: JWT verified, admin role required.
 * Deploy: supabase functions deploy edit-email-template
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const SYSTEM_PROMPT = `You are an expert email template editor. You will receive an HTML email template and an edit instruction.

RULES:
1. Apply the requested changes to the HTML.
2. Return ONLY the modified HTML — no explanation, no markdown fences, no commentary.
3. Preserve ALL template placeholder syntax exactly:
   - {{variable}} — simple placeholders
   - {{#if variable}}...{{/if}} — conditional blocks
   - {{#if variable}}...{{else}}...{{/if}} — if/else blocks
   Do NOT rename, remove, or alter any placeholder variables unless explicitly asked.
4. Keep the overall email structure (doctype, head, body, tables) intact.
5. Maintain inline CSS styles (email clients don't support <style> blocks well).
6. If the instruction is unclear, make a reasonable best guess and apply it.
7. The output must be valid HTML that renders correctly in email clients.`;

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Content-Type": "application/json",
  };

  try {
    // --- Auth ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: corsHeaders }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    // Check admin role
    const { data: appUser } = await supabase
      .from("app_users")
      .select("role")
      .eq("supabase_auth_id", user.id)
      .single();

    if (!appUser || appUser.role !== "admin") {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    // --- Parse request ---
    const { html, prompt } = await req.json();
    if (!html || !prompt) {
      return new Response(
        JSON.stringify({ error: "Both html and prompt are required" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // --- Call Gemini ---
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Gemini API key not configured" }),
        { status: 500, headers: corsHeaders }
      );
    }

    const geminiBody = {
      system_instruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: [
        {
          parts: [
            {
              text: `CURRENT HTML TEMPLATE:\n\n${html}\n\nEDIT INSTRUCTION:\n${prompt}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 16384,
      },
    };

    const geminiResp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });

    if (!geminiResp.ok) {
      const errText = await geminiResp.text();
      console.error("Gemini API error:", errText);
      return new Response(
        JSON.stringify({
          error: `Gemini API error: ${geminiResp.status}`,
          details: errText,
        }),
        { status: 502, headers: corsHeaders }
      );
    }

    const geminiData = await geminiResp.json();
    let resultHtml =
      geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // Strip markdown fences if Gemini wraps in ```html ... ```
    resultHtml = resultHtml
      .replace(/^```(?:html)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();

    if (!resultHtml) {
      return new Response(
        JSON.stringify({ error: "Gemini returned empty response" }),
        { status: 502, headers: corsHeaders }
      );
    }

    // --- Log API usage ---
    const inputTokens =
      geminiData.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens =
      geminiData.usageMetadata?.candidatesTokenCount ?? 0;
    // Gemini 2.5 Flash pricing: input $0.15/1M, output $3.50/1M (under 200k context)
    const estimatedCost =
      (inputTokens * 0.15 + outputTokens * 3.5) / 1_000_000;

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    await supabaseAdmin.from("api_usage_log").insert({
      vendor: "gemini",
      category: "email_template_edit",
      endpoint: "generateContent",
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: estimatedCost,
      metadata: {
        model: "gemini-2.5-flash",
        prompt_snippet: prompt.substring(0, 200),
      },
      app_user_id: appUser ? user.id : null,
    });

    return new Response(JSON.stringify({ html: resultHtml }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err) {
    console.error("edit-email-template error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
});
