import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface PaymentLinkRequest {
  amount: number;          // Amount in dollars (e.g., 299.00)
  description: string;     // e.g., "Weekly Rent - Feb 2, 2026"
  person_id?: string;      // Optional: link to person
  person_name?: string;    // Optional: prefill name
  person_email?: string;   // Optional: prefill email
  category?: string;       // Ledger category (rent, security_deposit, etc.)
  assignment_id?: string;  // Optional: link to assignment
  metadata?: Record<string, string>; // Optional extra metadata
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify user
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check role (admin/staff only)
    const { data: appUser } = await supabase
      .from("app_users")
      .select("role")
      .eq("supabase_auth_id", user.id)
      .single();

    if (!appUser || !["admin", "staff"].includes(appUser.role)) {
      return new Response(
        JSON.stringify({ error: "Admin or staff role required" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body: PaymentLinkRequest = await req.json();
    const { amount, description, person_id, person_name, person_email, category, assignment_id, metadata } = body;

    if (!amount || !description) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: amount, description" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Stripe secret key from DB
    const { data: stripeConfig } = await supabase
      .from("stripe_config")
      .select("secret_key, is_active, test_mode")
      .eq("id", 1)
      .single();

    if (!stripeConfig?.secret_key || !stripeConfig.is_active) {
      return new Response(
        JSON.stringify({ error: "Stripe is not configured or inactive" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build Stripe Payment Link request
    const amountCents = Math.round(amount * 100);

    const params = new URLSearchParams();
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", amountCents.toString());
    params.append("line_items[0][price_data][product_data][name]", description);
    params.append("line_items[0][quantity]", "1");

    // ACH only — low fees (0.8% capped at $5) vs card (2.9% + $0.30)
    params.append("payment_method_types[0]", "us_bank_account");

    // Add metadata for tracking
    if (person_id) params.append("metadata[person_id]", person_id);
    if (person_name) params.append("metadata[person_name]", person_name);
    if (category) params.append("metadata[category]", category);
    if (assignment_id) params.append("metadata[assignment_id]", assignment_id);
    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        params.append(`metadata[${k}]`, v);
      }
    }

    // After payment, redirect to a thank-you or property page
    params.append("after_completion[type]", "redirect");
    params.append("after_completion[redirect][url]", "https://YOUR_DOMAIN/residents/profile.html?payment=success");

    // Create Payment Link via Stripe API
    const stripeResponse = await fetch(`${STRIPE_API_BASE}/payment_links`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${stripeConfig.secret_key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const stripeResult = await stripeResponse.json();

    if (!stripeResponse.ok) {
      console.error("Stripe API error:", stripeResult);
      return new Response(
        JSON.stringify({ error: "Failed to create payment link", details: stripeResult.error?.message }),
        { status: stripeResponse.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Log to api_usage_log (fire-and-forget)
    supabase.from("api_usage_log").insert({
      vendor: "stripe",
      category: "payment_link_creation",
      endpoint: "POST /v1/payment_links",
      units: 1,
      unit_type: "api_calls",
      estimated_cost_usd: 0, // No cost to create links, only on payment
      metadata: {
        payment_link_id: stripeResult.id,
        amount,
        description,
        person_name,
        url: stripeResult.url,
      },
      app_user_id: appUser ? user.id : null,
    }).then(() => {});

    console.log("Payment link created:", { id: stripeResult.id, url: stripeResult.url, amount });

    return new Response(
      JSON.stringify({
        success: true,
        payment_link_id: stripeResult.id,
        url: stripeResult.url,
        amount,
        description,
      }),
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
