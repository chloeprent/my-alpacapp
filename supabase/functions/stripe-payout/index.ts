/**
 * Stripe Payout Edge Function
 *
 * Sends outbound ACH payments to workers/associates via Stripe Connect Transfers.
 * Associate must have stripe_connect_account_id (completed Connect onboarding).
 * Follows paypal-payout pattern: load config, identity gate, dual-write payouts + ledger.
 *
 * Deploy with: supabase functions deploy stripe-payout
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

interface PayoutRequest {
  associate_id: string;
  amount: number;
  time_entry_ids?: string[];
  notes?: string;
}

interface StripeConfig {
  secret_key: string | null;
  sandbox_secret_key: string | null;
  connect_enabled: boolean;
  is_active: boolean;
  test_mode: boolean;
}

function formEncode(obj: Record<string, string | number>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

async function createStripeTransfer(
  secretKey: string,
  amountCents: number,
  destinationAccountId: string,
  description: string,
  metadata: Record<string, string>
): Promise<{ id: string }> {
  const body = formEncode({
    amount: amountCents,
    currency: 'usd',
    destination: destinationAccountId,
    description: description.slice(0, 500),
    ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`metadata[${k}]`, v]))
  });

  const response = await fetch('https://api.stripe.com/v1/transfers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const text = await response.text();
  if (!response.ok) {
    const err = JSON.parse(text);
    const message = err?.error?.message || text;
    throw new Error(message);
  }
  return JSON.parse(text);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body: PayoutRequest = await req.json();
    const { associate_id, amount, time_entry_ids, notes } = body;

    console.log('Processing Stripe payout:', { associate_id, amount, entryCount: time_entry_ids?.length ?? 0 });

    if (!associate_id || !amount || amount <= 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'associate_id and positive amount are required' }),
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
        JSON.stringify({ success: false, error: 'Stripe is not active. Enable it in Settings.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    if (!stripeConfig.connect_enabled) {
      return new Response(
        JSON.stringify({ success: false, error: 'Stripe Connect is not enabled. Enable it in Settings.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const secretKey = stripeConfig.test_mode
      ? stripeConfig.sandbox_secret_key
      : stripeConfig.secret_key;
    if (!secretKey) {
      return new Response(
        JSON.stringify({ success: false, error: `Missing ${stripeConfig.test_mode ? 'sandbox' : 'production'} Stripe secret key` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: associate, error: assocError } = await supabase
      .from('associate_profiles')
      .select('*, app_user:app_user_id(display_name, first_name, last_name, person_id)')
      .eq('id', associate_id)
      .single();

    if (assocError || !associate) {
      return new Response(
        JSON.stringify({ success: false, error: 'Associate not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (associate.identity_verification_status !== 'verified') {
      return new Response(
        JSON.stringify({ success: false, error: 'Identity verification required before payout. The associate must upload and verify their ID first.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const connectAccountId = associate.stripe_connect_account_id;
    if (!connectAccountId) {
      return new Response(
        JSON.stringify({ success: false, error: 'No Stripe Connect account linked for this associate. They must complete Stripe Connect onboarding first.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const personName = associate.app_user?.display_name
      || `${associate.app_user?.first_name || ''} ${associate.app_user?.last_name || ''}`.trim()
      || 'Unknown';
    const personId = associate.app_user?.person_id || null;
    const amountCents = Math.round(amount * 100);
    const description = notes ? `YOUR_PROPERTY_NAME: ${notes}` : `Associate payment: ${personName}`;

    if (stripeConfig.test_mode) {
      console.log('TEST MODE: Would send Stripe transfer:', {
        destination: connectAccountId,
        amountCents,
        description
      });

      const { data: payout, error: payoutError } = await supabase
        .from('payouts')
        .insert({
          associate_id,
          person_id: personId,
          person_name: personName,
          amount,
          payment_method: 'stripe',
          payment_handle: connectAccountId,
          external_payout_id: `TEST-tr_${Date.now()}`,
          status: 'completed',
          time_entry_ids: time_entry_ids || [],
          notes: `[TEST MODE] ${notes || ''}`.trim(),
          is_test: true
        })
        .select()
        .single();

      if (payoutError) console.error('Error creating test payout record:', payoutError);

      const { data: ledgerEntry, error: ledgerError } = await supabase
        .from('ledger')
        .insert({
          direction: 'expense',
          category: 'associate_payment',
          amount,
          payment_method: 'stripe',
          transaction_date: new Date().toISOString().split('T')[0],
          person_id: personId,
          person_name: personName,
          status: 'completed',
          description: `Stripe payout to ${personName}`,
          notes: `[TEST MODE] ${notes || ''}`.trim(),
          recorded_by: 'system:stripe-payout',
          is_test: true
        })
        .select()
        .single();

      if (ledgerError) console.error('Error creating test ledger entry:', ledgerError);
      if (payout && ledgerEntry) {
        await supabase.from('payouts').update({ ledger_id: ledgerEntry.id }).eq('id', payout.id);
      }

      await supabase.from('api_usage_log').insert({
        vendor: 'stripe',
        category: 'stripe_associate_payout',
        endpoint: 'transfers.create',
        units: 1,
        unit_type: 'api_calls',
        estimated_cost_usd: 0,
        metadata: { test_mode: true, associate_id }
      });

      return new Response(
        JSON.stringify({
          success: true,
          test_mode: true,
          payout_id: payout?.id,
          ledger_id: ledgerEntry?.id,
          message: `[TEST] Would have sent $${amount.toFixed(2)} to ${personName} via Stripe`
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const transfer = await createStripeTransfer(
      secretKey,
      amountCents,
      connectAccountId,
      description,
      { payout_associate_id: associate_id }
    );

    console.log('Stripe transfer created:', transfer.id);

    const { data: payout, error: payoutError } = await supabase
      .from('payouts')
      .insert({
        associate_id,
        person_id: personId,
        person_name: personName,
        amount,
        payment_method: 'stripe',
        payment_handle: connectAccountId,
        external_payout_id: transfer.id,
        status: 'processing',
        time_entry_ids: time_entry_ids || [],
        notes: notes || null,
        is_test: false
      })
      .select()
      .single();

    if (payoutError) {
      console.error('Error creating payout record:', payoutError);
    }

    const { data: ledgerEntry, error: ledgerError } = await supabase
      .from('ledger')
      .insert({
        direction: 'expense',
        category: 'associate_payment',
        amount,
        payment_method: 'stripe',
        transaction_date: new Date().toISOString().split('T')[0],
        person_id: personId,
        person_name: personName,
        status: 'pending',
        description: `Stripe payout to ${personName}`,
        notes: notes || null,
        recorded_by: 'system:stripe-payout',
        is_test: false
      })
      .select()
      .single();

    if (ledgerError) console.error('Error creating ledger entry:', ledgerError);
    if (payout && ledgerEntry) {
      await supabase.from('payouts').update({ ledger_id: ledgerEntry.id }).eq('id', payout.id);
    }

    await supabase.from('api_usage_log').insert({
      vendor: 'stripe',
      category: 'stripe_associate_payout',
      endpoint: 'transfers.create',
      units: 1,
      unit_type: 'api_calls',
      estimated_cost_usd: 0,
      metadata: { transfer_id: transfer.id, associate_id }
    });

    // Send payout notification email (fire-and-forget, goes through approval workflow)
    try {
      // Look up associate's email from people table
      let recipientEmail = associate.payment_handle;
      if (personId) {
        const { data: person } = await supabase
          .from('people')
          .select('email')
          .eq('id', personId)
          .single();
        if (person?.email) recipientEmail = person.email;
      }
      if (recipientEmail) {
        const firstName = associate.app_user?.first_name || personName.split(' ')[0] || 'there';
        const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
        await fetch(`${supabaseUrl}/functions/v1/send-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`
          },
          body: JSON.stringify({
            type: 'associate_payout_sent',
            to: recipientEmail,
            data: {
              first_name: firstName,
              amount: amount.toFixed(2),
              payment_method: 'Stripe (ACH)',
              payout_date: today,
              hours: associate.hourly_rate && amount > 0 ? (amount / parseFloat(associate.hourly_rate)).toFixed(1) : null,
              hourly_rate: associate.hourly_rate || null,
              notes: notes || null
            }
          })
        });
        console.log('Payout notification email queued for', recipientEmail);
      }
    } catch (emailErr) {
      console.error('Non-fatal: payout email failed:', emailErr);
    }

    return new Response(
      JSON.stringify({
        success: true,
        payout_id: payout?.id,
        ledger_id: ledgerEntry?.id,
        transfer_id: transfer.id,
        message: `Sent $${amount.toFixed(2)} to ${personName} via Stripe`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Stripe payout error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
