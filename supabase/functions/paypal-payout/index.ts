/**
 * PayPal Payout Edge Function
 *
 * Sends outbound payments to workers/associates via PayPal Payouts API.
 * Follows the same pattern as process-square-payment: load config from DB,
 * call external API, dual-write to payouts + ledger tables.
 *
 * Deploy with: supabase functions deploy paypal-payout
 * Endpoint: YOUR_SUPABASE_URL/functions/v1/paypal-payout
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

interface PayoutRequest {
  associate_id: string;
  amount: number;           // Amount in dollars (e.g., 150.00)
  time_entry_ids?: string[];
  notes?: string;
  payment_handle?: string;  // Override PayPal email (otherwise pulled from associate_profiles)
}

interface PayPalConfig {
  client_id: string;
  client_secret: string;
  sandbox_client_id: string;
  sandbox_client_secret: string;
  is_active: boolean;
  test_mode: boolean;
}

/**
 * Get PayPal OAuth access token using client credentials
 */
async function getPayPalAccessToken(config: PayPalConfig): Promise<string> {
  const clientId = config.test_mode ? config.sandbox_client_id : config.client_id;
  const clientSecret = config.test_mode ? config.sandbox_client_secret : config.client_secret;
  const baseUrl = config.test_mode
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

  const credentials = btoa(`${clientId}:${clientSecret}`);

  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PayPal auth failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Send a PayPal payout to a single recipient
 */
async function sendPayPalPayout(
  accessToken: string,
  config: PayPalConfig,
  recipientEmail: string,
  amount: number,
  senderBatchId: string,
  note?: string
): Promise<{ batch_id: string; payout_item_id?: string }> {
  const baseUrl = config.test_mode
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

  const payload = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: 'You have a payment from YOUR_PROPERTY_NAME',
      email_message: note || 'Thank you for your work!',
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: {
          value: amount.toFixed(2),
          currency: 'USD',
        },
        receiver: recipientEmail,
        note: note || 'Payment from YOUR_PROPERTY_NAME',
        sender_item_id: senderBatchId,
      },
    ],
  };

  const response = await fetch(`${baseUrl}/v1/payments/payouts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PayPal payout failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return {
    batch_id: data.batch_header?.payout_batch_id,
    payout_item_id: data.items?.[0]?.payout_item_id,
  };
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
    const body: PayoutRequest = await req.json();
    const { associate_id, amount, time_entry_ids, notes, payment_handle } = body;

    console.log('Processing PayPal payout:', { associate_id, amount, entryCount: time_entry_ids ? time_entry_ids.length : 0 });

    if (!associate_id || !amount || amount <= 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'associate_id and positive amount are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Load PayPal config
    const { data: config, error: configError } = await supabase
      .from('paypal_config')
      .select('*')
      .single();

    if (configError || !config) {
      return new Response(
        JSON.stringify({ success: false, error: 'PayPal configuration not found' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!config.is_active) {
      return new Response(
        JSON.stringify({ success: false, error: 'PayPal is not active. Enable it in Settings.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Load associate info for PayPal email
    const { data: associate, error: assocError } = await supabase
      .from('associate_profiles')
      .select('*, app_user:app_user_id(display_name, first_name, last_name, person_id, email)')
      .eq('id', associate_id)
      .single();

    if (assocError || !associate) {
      return new Response(
        JSON.stringify({ success: false, error: 'Associate not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Identity verification gate — must be verified before payout
    if (associate.identity_verification_status !== 'verified') {
      return new Response(
        JSON.stringify({ success: false, error: 'Identity verification required before payout. The associate must upload and verify their ID first.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Determine PayPal email
    const paypalEmail = payment_handle || associate.payment_handle;
    if (!paypalEmail) {
      return new Response(
        JSON.stringify({ success: false, error: 'No PayPal email configured for this associate. Update their payment info first.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const personName = associate.app_user?.display_name
      || `${associate.app_user?.first_name || ''} ${associate.app_user?.last_name || ''}`.trim()
      || 'Unknown';
    const personId = associate.app_user?.person_id || null;

    // Generate unique batch ID
    const senderBatchId = `APC-${Date.now()}-${associate_id.slice(0, 8)}`;

    // Test mode: log but don't call PayPal
    if (config.test_mode) {
      console.log('TEST MODE: Would send PayPal payout:', {
        recipient: paypalEmail,
        amount,
        senderBatchId,
      });

      // Create payout record (test)
      const { data: payout, error: payoutError } = await supabase
        .from('payouts')
        .insert({
          associate_id,
          person_id: personId,
          person_name: personName,
          amount,
          payment_method: 'paypal',
          payment_handle: paypalEmail,
          external_payout_id: `TEST-${senderBatchId}`,
          status: 'completed',
          time_entry_ids: time_entry_ids || [],
          notes: `[TEST MODE] ${notes || ''}`.trim(),
          is_test: true,
        })
        .select()
        .single();

      if (payoutError) {
        console.error('Error creating test payout record:', payoutError);
      }

      // Create ledger entry (test)
      const { data: ledgerEntry, error: ledgerError } = await supabase
        .from('ledger')
        .insert({
          direction: 'expense',
          category: 'associate_payment',
          amount,
          payment_method: 'paypal',
          transaction_date: new Date().toISOString().split('T')[0],
          person_id: personId,
          person_name: personName,
          status: 'completed',
          description: `PayPal payout to ${personName}`,
          notes: `[TEST MODE] ${notes || ''}`.trim(),
          recorded_by: 'system:paypal-payout',
          is_test: true,
        })
        .select()
        .single();

      if (ledgerError) {
        console.error('Error creating test ledger entry:', ledgerError);
      }

      // Link ledger to payout
      if (payout && ledgerEntry) {
        await supabase.from('payouts').update({ ledger_id: ledgerEntry.id }).eq('id', payout.id);
      }

      return new Response(
        JSON.stringify({
          success: true,
          test_mode: true,
          payout_id: payout?.id,
          ledger_id: ledgerEntry?.id,
          message: `[TEST] Would have sent $${amount.toFixed(2)} to ${paypalEmail}`,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // PRODUCTION: Send real PayPal payout
    const accessToken = await getPayPalAccessToken(config);
    const result = await sendPayPalPayout(accessToken, config, paypalEmail, amount, senderBatchId, notes);

    console.log('PayPal payout sent:', result);

    // Create payout record
    const { data: payout, error: payoutError } = await supabase
      .from('payouts')
      .insert({
        associate_id,
        person_id: personId,
        person_name: personName,
        amount,
        payment_method: 'paypal',
        payment_handle: paypalEmail,
        external_payout_id: result.batch_id,
        external_item_id: result.payout_item_id,
        status: 'processing',
        time_entry_ids: time_entry_ids || [],
        notes: notes || null,
        is_test: false,
      })
      .select()
      .single();

    if (payoutError) {
      console.error('Error creating payout record:', payoutError);
    }

    // Create ledger entry
    const { data: ledgerEntry, error: ledgerError } = await supabase
      .from('ledger')
      .insert({
        direction: 'expense',
        category: 'associate_payment',
        amount,
        payment_method: 'paypal',
        transaction_date: new Date().toISOString().split('T')[0],
        person_id: personId,
        person_name: personName,
        status: 'pending',
        description: `PayPal payout to ${personName}`,
        notes: notes || null,
        recorded_by: 'system:paypal-payout',
        is_test: false,
      })
      .select()
      .single();

    if (ledgerError) {
      console.error('Error creating ledger entry:', ledgerError);
    }

    // Link ledger to payout
    if (payout && ledgerEntry) {
      await supabase.from('payouts').update({ ledger_id: ledgerEntry.id }).eq('id', payout.id);
    }

    // Send payout notification email (fire-and-forget, goes through approval workflow)
    try {
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
              payment_method: 'PayPal',
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
        batch_id: result.batch_id,
        message: `Sent $${amount.toFixed(2)} to ${paypalEmail} via PayPal`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('PayPal payout error:', error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
