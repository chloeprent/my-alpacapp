/**
 * Process Stripe Payment (create PaymentIntent)
 *
 * Creates a Stripe PaymentIntent for inbound ACH/card payments. Client confirms
 * with Stripe.js; webhook (payment_intent.succeeded) creates ledger entry.
 * Follows process-square-payment pattern: load config, create payment record, call API.
 *
 * Deploy with: supabase functions deploy process-stripe-payment
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

interface CreatePaymentRequest {
  amount: number;           // Total amount in cents (including fee)
  original_amount?: number; // Base amount in cents (before fee)
  fee_amount?: number;      // Processing fee in cents
  description?: string;
  payment_type: string;    // e.g. rental_application, rent, event_cleaning_deposit
  reference_type: string;   // e.g. rental_application, assignment, event_request
  reference_id: string;     // UUID
  person_id?: string;
  person_name?: string;
  buyer_email?: string;
}

interface StripeConfig {
  secret_key: string | null;
  sandbox_secret_key: string | null;
  is_active: boolean;
  test_mode: boolean;
}

function formEncode(obj: Record<string, string | number | boolean>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

async function createPaymentIntent(
  secretKey: string,
  amountCents: number,
  description: string,
  metadata: Record<string, string>,
  buyerEmail?: string
): Promise<{ id: string; client_secret: string }> {
  const body: Record<string, string | number | boolean> = {
    amount: amountCents,
    currency: 'usd',
    'payment_method_types[0]': 'us_bank_account',
    description: description.slice(0, 500),
    ...Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [`metadata[${k}]`, v])
    )
  };
  if (buyerEmail) body.receipt_email = buyerEmail;

  const response = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formEncode(body)
  });

  const text = await response.text();
  if (!response.ok) {
    const err = JSON.parse(text);
    throw new Error(err?.error?.message || text);
  }
  const data = JSON.parse(text);
  return { id: data.id, client_secret: data.client_secret };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body: CreatePaymentRequest = await req.json();
    const {
      amount,
      original_amount,
      fee_amount,
      description,
      payment_type,
      reference_type,
      reference_id,
      person_id,
      person_name,
      buyer_email
    } = body;

    if (!amount || amount < 50) {
      return new Response(
        JSON.stringify({ success: false, error: 'amount (cents, min 50) is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    if (!payment_type || !reference_type || !reference_id) {
      return new Response(
        JSON.stringify({ success: false, error: 'payment_type, reference_type, and reference_id are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: config, error: configError } = await supabase
      .from('stripe_config')
      .select('*')
      .single();

    if (configError || !config) {
      return new Response(
        JSON.stringify({ success: false, error: 'Stripe configuration not found' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const stripeConfig = config as StripeConfig;
    if (!stripeConfig.is_active) {
      return new Response(
        JSON.stringify({ success: false, error: 'Stripe is not active in Settings.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const secretKey = stripeConfig.test_mode
      ? stripeConfig.sandbox_secret_key
      : stripeConfig.secret_key;
    if (!secretKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'Stripe secret key not configured' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const amountDollars = amount / 100;
    const originalDollars = original_amount ? original_amount / 100 : amountDollars;
    const feeDollars = fee_amount ? fee_amount / 100 : 0;
    const desc = description || `${payment_type.replace(/_/g, ' ')} — ${reference_id}`;

    const { data: paymentRecord, error: insertError } = await supabase
      .from('stripe_payments')
      .insert({
        payment_type,
        reference_type,
        reference_id,
        amount: amountDollars,
        original_amount: originalDollars,
        fee_amount: feeDollars,
        status: 'pending',
        person_id: person_id || null,
        person_name: person_name || null,
        is_test: stripeConfig.test_mode
      })
      .select()
      .single();

    if (insertError) {
      console.error('Failed to create stripe_payments record:', insertError);
      return new Response(
        JSON.stringify({ success: false, error: 'Failed to create payment record' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const pi = await createPaymentIntent(
      secretKey,
      amount,
      desc,
      {
        payment_record_id: paymentRecord.id,
        payment_type,
        reference_type,
        reference_id,
        ...(person_id ? { person_id } : {}),
        ...(person_name ? { person_name: person_name.slice(0, 100) } : {})
      },
      buyer_email
    );

    await supabase
      .from('stripe_payments')
      .update({
        stripe_payment_intent_id: pi.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', paymentRecord.id);

    await supabase.from('api_usage_log').insert({
      vendor: 'stripe',
      category: 'stripe_payment_processing',
      endpoint: 'payment_intents.create',
      units: 1,
      unit_type: 'api_calls',
      estimated_cost_usd: 0,
      metadata: { payment_type, test_mode: stripeConfig.test_mode }
    });

    return new Response(
      JSON.stringify({
        success: true,
        clientSecret: pi.client_secret,
        paymentIntentId: pi.id,
        paymentRecordId: paymentRecord.id
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Process Stripe payment error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
