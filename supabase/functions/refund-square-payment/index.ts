/**
 * Refund Square Payment Edge Function
 *
 * Processes refunds via Square Refunds API.
 * Supports full and partial refunds.
 *
 * Deploy with: supabase functions deploy refund-square-payment
 * Endpoint: YOUR_SUPABASE_URL/functions/v1/refund-square-payment
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

interface RefundRequest {
  square_payment_id: string;  // Square's payment ID (from Square API)
  amount_cents: number;       // Amount in cents to refund
  reason?: string;            // Admin-provided reason
  ledger_id?: string;         // Original ledger entry to link refund to
  payment_record_id?: string; // Our internal square_payments UUID
}

interface SquareConfig {
  sandbox_access_token: string;
  production_access_token: string;
  sandbox_location_id: string;
  production_location_id: string;
  test_mode: boolean;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body: RefundRequest = await req.json();
    const { square_payment_id, amount_cents, reason, ledger_id, payment_record_id } = body;

    console.log('Processing Square refund:', { square_payment_id, amount_cents, reason });

    if (!square_payment_id || !amount_cents) {
      return new Response(
        JSON.stringify({ success: false, error: 'square_payment_id and amount_cents are required' }),
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
    const isTestMode = squareConfig.test_mode;
    const accessToken = isTestMode ? squareConfig.sandbox_access_token : squareConfig.production_access_token;
    const apiBase = isTestMode ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';

    // Create idempotency key
    const idempotencyKey = `refund-${payment_record_id || square_payment_id}-${Date.now()}`;

    // Call Square Refunds API
    const refundPayload = {
      idempotency_key: idempotencyKey,
      payment_id: square_payment_id,
      amount_money: {
        amount: amount_cents,
        currency: 'USD'
      },
      reason: reason || 'Refund processed by admin'
    };

    console.log('Calling Square Refunds API:', { apiBase, amount_cents });

    const squareResponse = await fetch(`${apiBase}/v2/refunds`, {
      method: 'POST',
      headers: {
        'Square-Version': '2024-01-18',
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(refundPayload)
    });

    const squareResult = await squareResponse.json();

    if (!squareResponse.ok || squareResult.errors) {
      const errorMessage = squareResult.errors?.[0]?.detail || 'Refund failed';
      console.error('Square refund failed:', squareResult);

      return new Response(
        JSON.stringify({
          success: false,
          error: errorMessage,
          details: squareResult.errors
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const refund = squareResult.refund;
    console.log('Square refund successful:', refund.id);

    // Update square_payments record if we have the internal ID
    if (payment_record_id) {
      const refundAmountDollars = amount_cents / 100;
      await supabase
        .from('square_payments')
        .update({
          status: 'refunded',
          refund_id: refund.id,
          refund_amount: refundAmountDollars,
          refunded_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', payment_record_id);
    }

    // Insert refund entry into ledger
    const refundAmountDollars = amount_cents / 100;
    const ledgerEntry: Record<string, unknown> = {
      direction: 'expense',
      category: 'refund',
      amount: refundAmountDollars,
      payment_method: 'square',
      transaction_date: new Date().toISOString().split('T')[0],
      square_refund_id: refund.id,
      status: 'completed',
      description: `Square refund: ${reason || 'No reason provided'}`,
      recorded_by: 'system:refund-edge-function'
    };

    if (ledger_id) {
      ledgerEntry.refund_of_ledger_id = ledger_id;

      // Get person info from original ledger entry
      const { data: originalEntry } = await supabase
        .from('ledger')
        .select('person_id, person_name, rental_application_id, event_request_id')
        .eq('id', ledger_id)
        .single();

      if (originalEntry) {
        ledgerEntry.person_id = originalEntry.person_id;
        ledgerEntry.person_name = originalEntry.person_name;
        ledgerEntry.rental_application_id = originalEntry.rental_application_id;
        ledgerEntry.event_request_id = originalEntry.event_request_id;
      }
    }

    const { error: ledgerError } = await supabase
      .from('ledger')
      .insert(ledgerEntry);

    if (ledgerError) {
      console.error('Failed to insert ledger entry (refund still processed):', ledgerError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        refundId: refund.id,
        amount: refundAmountDollars,
        status: refund.status
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error processing refund:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
