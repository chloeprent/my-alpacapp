/**
 * Process Square Payment Edge Function
 *
 * Receives a tokenized card from the client and processes payment via Square API.
 * Supports per-session test mode override for staff/admin users.
 *
 * Deploy with: supabase functions deploy process-square-payment
 * Endpoint: YOUR_SUPABASE_URL/functions/v1/process-square-payment
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

interface PaymentRequest {
  sourceId: string;       // Card token from Square Web SDK
  amount: number;         // Amount in cents
  paymentRecordId: string; // Our internal payment record ID
  buyerEmail?: string;
  note?: string;
  testModeOverride?: boolean;   // Per-session sandbox override (staff/admin only)
  userAccessToken?: string;     // Caller's JWT for verifying staff/admin role
}

interface SquareConfig {
  sandbox_access_token: string;
  production_access_token: string;
  sandbox_location_id: string;
  production_location_id: string;
  test_mode: boolean;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body
    const body: PaymentRequest = await req.json();
    const { sourceId, amount, paymentRecordId, buyerEmail, note, testModeOverride, userAccessToken } = body;

    console.log('Processing Square payment:', { amount, paymentRecordId, buyerEmail, testModeOverride: !!testModeOverride });

    if (!sourceId || !amount || !paymentRecordId) {
      return new Response(
        JSON.stringify({ success: false, error: 'sourceId, amount, and paymentRecordId are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get Square configuration
    const { data: config, error: configError } = await supabase
      .from('square_config')
      .select('*')
      .single();

    if (configError || !config) {
      console.error('Failed to load Square config:', configError);
      return new Response(
        JSON.stringify({ success: false, error: 'Square configuration not found' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const squareConfig = config as SquareConfig;
    let isTestMode = squareConfig.test_mode;
    let overriddenByUserId: string | null = null;

    // Handle per-session test mode override (staff/admin only)
    if (testModeOverride === true) {
      if (!userAccessToken) {
        return new Response(
          JSON.stringify({ success: false, error: 'Authentication required for test mode override' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Verify the caller's JWT
      const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!;
      const userClient = createClient(supabaseUrl, supabaseAnon, {
        global: { headers: { Authorization: `Bearer ${userAccessToken}` } }
      });
      const { data: { user }, error: authError } = await userClient.auth.getUser();

      if (authError || !user) {
        console.error('Test mode override auth failed:', authError);
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid authentication token' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Verify staff/admin role in app_users
      const { data: appUser, error: roleError } = await supabase
        .from('app_users')
        .select('id, role')
        .eq('auth_user_id', user.id)
        .single();

      if (roleError || !appUser || !['oracle', 'admin', 'staff'].includes(appUser.role)) {
        console.error('Test mode override denied — not staff/admin:', user.email);
        return new Response(
          JSON.stringify({ success: false, error: 'Staff or admin role required for test mode override' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      isTestMode = true;
      overriddenByUserId = appUser.id;
      console.log(`Test mode override authorized for ${user.email} (app_users.id: ${appUser.id})`);
    }

    const accessToken = isTestMode ? squareConfig.sandbox_access_token : squareConfig.production_access_token;
    const locationId = isTestMode ? squareConfig.sandbox_location_id : squareConfig.production_location_id;
    const apiBase = isTestMode ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';

    // Create idempotency key using payment record ID
    const idempotencyKey = `payment-${paymentRecordId}`;

    // Build payment request
    const paymentPayload: Record<string, unknown> = {
      source_id: sourceId,
      idempotency_key: idempotencyKey,
      amount_money: {
        amount: amount,
        currency: 'USD'
      },
      location_id: locationId,
      autocomplete: true
    };

    if (buyerEmail) {
      paymentPayload.buyer_email_address = buyerEmail;
    }

    if (note) {
      paymentPayload.note = note;
    }

    console.log('Calling Square API:', { apiBase, locationId, amount, isTestMode });

    // Call Square Payments API
    const squareResponse = await fetch(`${apiBase}/v2/payments`, {
      method: 'POST',
      headers: {
        'Square-Version': '2024-01-18',
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paymentPayload)
    });

    const squareResult = await squareResponse.json();

    if (!squareResponse.ok || squareResult.errors) {
      const errorMessage = squareResult.errors?.[0]?.detail || 'Payment failed';
      console.error('Square payment failed:', squareResult);

      return new Response(
        JSON.stringify({
          success: false,
          error: errorMessage,
          details: squareResult.errors
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const payment = squareResult.payment;
    console.log('Square payment successful:', payment.id);

    // Update payment record with test mode audit info
    const updateData: Record<string, unknown> = {
      is_test: isTestMode,
      updated_at: new Date().toISOString()
    };
    if (overriddenByUserId) {
      updateData.test_mode_overridden_by = overriddenByUserId;
    }
    await supabase
      .from('square_payments')
      .update(updateData)
      .eq('id', paymentRecordId);

    return new Response(
      JSON.stringify({
        success: true,
        paymentId: payment.id,
        orderId: payment.order_id,
        receiptUrl: payment.receipt_url,
        status: payment.status,
        isTest: isTestMode
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error processing payment:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
