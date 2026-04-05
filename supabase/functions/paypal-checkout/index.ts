/**
 * PayPal Checkout Edge Function
 *
 * Handles PayPal Orders API for receiving payments from tenants.
 * Two actions:
 *   - create_order: Creates a PayPal order for the given amount
 *   - capture_order: Captures payment after user approves in PayPal
 *
 * Deploy with: supabase functions deploy paypal-checkout --no-verify-jwt
 * Endpoint: YOUR_SUPABASE_URL/functions/v1/paypal-checkout
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PayPalConfig {
  client_id: string;
  client_secret: string;
  sandbox_client_id: string;
  sandbox_client_secret: string;
  is_active: boolean;
  test_mode: boolean;
}

interface CreateOrderRequest {
  action: 'create_order';
  amount: number;           // Amount in dollars
  description?: string;
  payment_type?: string;    // rent, security_deposit, move_in_deposit, etc.
  reference_type?: string;  // assignment, rental_application, etc.
  reference_id?: string;
  person_id?: string;
  person_name?: string;
  buyer_email?: string;
}

interface CaptureOrderRequest {
  action: 'capture_order';
  order_id: string;         // PayPal order ID to capture
  payment_record_id?: string; // Our paypal_payments.id
}

/**
 * Get PayPal OAuth access token
 */
async function getAccessToken(config: PayPalConfig): Promise<string> {
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
    const err = await response.text();
    throw new Error(`PayPal auth failed: ${response.status} ${err}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Create a PayPal order (Orders API v2)
 */
async function createPayPalOrder(
  accessToken: string,
  config: PayPalConfig,
  amount: number,
  description: string,
  referenceId: string
): Promise<{ id: string; status: string; approve_url: string }> {
  const baseUrl = config.test_mode
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

  const payload = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: referenceId,
      description: description || 'YOUR_PROPERTY_NAME Payment',
      amount: {
        currency_code: 'USD',
        value: amount.toFixed(2),
      },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'YOUR_PROPERTY_NAME',
          landing_page: 'NO_PREFERENCE',
          user_action: 'PAY_NOW',
          return_url: 'https://YOUR_DOMAIN/pay/?paypal_success=true',
          cancel_url: 'https://YOUR_DOMAIN/pay/?paypal_cancelled=true',
        },
      },
    },
  };

  const response = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`PayPal create order failed: ${response.status} ${err}`);
  }

  const data = await response.json();

  // Find the approval URL
  const approveLink = data.links?.find((l: { rel: string }) => l.rel === 'payer-action')
    || data.links?.find((l: { rel: string }) => l.rel === 'approve');

  return {
    id: data.id,
    status: data.status,
    approve_url: approveLink?.href || '',
  };
}

/**
 * Capture a PayPal order after payer approval
 */
async function capturePayPalOrder(
  accessToken: string,
  config: PayPalConfig,
  orderId: string
): Promise<{
  id: string;
  status: string;
  capture_id: string;
  payer_email: string;
  payer_name: string;
  payer_id: string;
  amount: number;
  raw: Record<string, unknown>;
}> {
  const baseUrl = config.test_mode
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

  const response = await fetch(`${baseUrl}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`PayPal capture failed: ${response.status} ${err}`);
  }

  const data = await response.json();

  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  const payer = data.payer;

  return {
    id: data.id,
    status: data.status,
    capture_id: capture?.id || '',
    payer_email: payer?.email_address || '',
    payer_name: `${payer?.name?.given_name || ''} ${payer?.name?.surname || ''}`.trim(),
    payer_id: payer?.payer_id || '',
    amount: parseFloat(capture?.amount?.value || '0'),
    raw: data,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { action } = body;

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
        JSON.stringify({ success: false, error: 'PayPal payments are not currently enabled' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ---- CREATE ORDER ----
    if (action === 'create_order') {
      const { amount, description, payment_type, reference_type, reference_id, person_id, person_name } = body as CreateOrderRequest;

      if (!amount || amount < 0.50) {
        return new Response(
          JSON.stringify({ success: false, error: 'Amount must be at least $0.50' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const internalRefId = reference_id || crypto.randomUUID();
      const accessToken = await getAccessToken(config);

      // Test mode: skip PayPal API, return mock order
      if (config.test_mode) {
        const mockOrderId = `TEST-${Date.now()}`;

        const { data: paymentRecord } = await supabase
          .from('paypal_payments')
          .insert({
            paypal_order_id: mockOrderId,
            amount,
            status: 'pending',
            payment_type: payment_type || 'other',
            reference_type: reference_type || 'direct_payment',
            reference_id: internalRefId,
            person_id: person_id || null,
            person_name: person_name || null,
            description: description || 'Payment',
            is_test: true,
          })
          .select()
          .single();

        return new Response(
          JSON.stringify({
            success: true,
            test_mode: true,
            order_id: mockOrderId,
            payment_record_id: paymentRecord?.id,
            approve_url: '',
            message: `[TEST] Order created for $${amount.toFixed(2)}`,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Production: create real PayPal order
      const order = await createPayPalOrder(
        accessToken,
        config,
        amount,
        description || 'YOUR_PROPERTY_NAME Payment',
        internalRefId
      );

      // Create local payment record
      const { data: paymentRecord } = await supabase
        .from('paypal_payments')
        .insert({
          paypal_order_id: order.id,
          amount,
          status: 'pending',
          payment_type: payment_type || 'other',
          reference_type: reference_type || 'direct_payment',
          reference_id: internalRefId,
          person_id: person_id || null,
          person_name: person_name || null,
          description: description || 'Payment',
          is_test: false,
        })
        .select()
        .single();

      console.log('PayPal order created:', { order_id: order.id, amount, payment_record_id: paymentRecord?.id });

      // Log API usage
      await supabase.from('api_usage_log').insert({
        vendor: 'paypal',
        category: 'square_payment_processing',  // Reusing generic payment category
        endpoint: 'v2/checkout/orders',
        units: 1,
        unit_type: 'api_calls',
        estimated_cost_usd: 0,
        metadata: { order_id: order.id, amount, test_mode: false },
      });

      return new Response(
        JSON.stringify({
          success: true,
          order_id: order.id,
          payment_record_id: paymentRecord?.id,
          approve_url: order.approve_url,
          client_id: config.client_id, // Needed for JS SDK
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ---- CAPTURE ORDER ----
    if (action === 'capture_order') {
      const { order_id, payment_record_id } = body as CaptureOrderRequest;

      if (!order_id) {
        return new Response(
          JSON.stringify({ success: false, error: 'order_id is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Test mode: mock capture
      if (config.test_mode) {
        if (payment_record_id) {
          await supabase.from('paypal_payments').update({
            status: 'completed',
            paypal_capture_id: `TEST-CAP-${Date.now()}`,
            paypal_payer_email: 'test@sandbox.paypal.com',
            paypal_payer_name: 'Test User',
            updated_at: new Date().toISOString(),
          }).eq('id', payment_record_id);
        }

        // Find payment record for ledger entry
        const { data: payment } = await supabase
          .from('paypal_payments')
          .select('*')
          .eq('id', payment_record_id)
          .single();

        if (payment) {
          await supabase.from('ledger').insert({
            direction: 'income',
            category: mapPaymentTypeToCategory(payment.payment_type),
            amount: payment.amount,
            payment_method: 'paypal',
            transaction_date: new Date().toISOString().split('T')[0],
            person_id: payment.person_id,
            person_name: payment.person_name,
            paypal_payment_id: payment.id,
            paypal_transaction_id: `TEST-CAP-${Date.now()}`,
            status: 'completed',
            description: `PayPal payment: ${payment.description || payment.payment_type}`,
            recorded_by: 'system:paypal-checkout',
            is_test: true,
          });
        }

        return new Response(
          JSON.stringify({ success: true, test_mode: true, message: '[TEST] Payment captured' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Production: capture the order
      const accessToken = await getAccessToken(config);
      const capture = await capturePayPalOrder(accessToken, config, order_id);

      console.log('PayPal payment captured:', {
        order_id,
        capture_id: capture.capture_id,
        amount: capture.amount,
        payer: capture.payer_email,
      });

      // Update paypal_payments record
      let paymentRecord: Record<string, unknown> | null = null;

      if (payment_record_id) {
        const { data } = await supabase
          .from('paypal_payments')
          .update({
            status: capture.status === 'COMPLETED' ? 'completed' : 'failed',
            paypal_capture_id: capture.capture_id,
            paypal_payer_id: capture.payer_id,
            paypal_payer_email: capture.payer_email,
            paypal_payer_name: capture.payer_name,
            raw_response: capture.raw,
            updated_at: new Date().toISOString(),
          })
          .eq('id', payment_record_id)
          .select()
          .single();
        paymentRecord = data;
      } else {
        // Try to find by order ID
        const { data } = await supabase
          .from('paypal_payments')
          .update({
            status: capture.status === 'COMPLETED' ? 'completed' : 'failed',
            paypal_capture_id: capture.capture_id,
            paypal_payer_id: capture.payer_id,
            paypal_payer_email: capture.payer_email,
            paypal_payer_name: capture.payer_name,
            raw_response: capture.raw,
            updated_at: new Date().toISOString(),
          })
          .eq('paypal_order_id', order_id)
          .select()
          .single();
        paymentRecord = data;
      }

      // Dual-write to ledger if payment was completed
      if (capture.status === 'COMPLETED' && paymentRecord) {
        const pr = paymentRecord as Record<string, unknown>;
        const { data: ledgerEntry } = await supabase.from('ledger').insert({
          direction: 'income',
          category: mapPaymentTypeToCategory(pr.payment_type as string),
          amount: capture.amount,
          payment_method: 'paypal',
          transaction_date: new Date().toISOString().split('T')[0],
          person_id: pr.person_id || null,
          person_name: pr.person_name || capture.payer_name || null,
          paypal_payment_id: pr.id,
          paypal_transaction_id: capture.capture_id,
          status: 'completed',
          description: `PayPal payment: ${pr.description || pr.payment_type || 'Payment'}`,
          notes: `Payer: ${capture.payer_email}`,
          recorded_by: 'system:paypal-checkout',
          is_test: false,
          // Link to source records if available
          assignment_id: pr.reference_type === 'assignment' ? pr.reference_id : null,
          rental_application_id: pr.reference_type === 'rental_application' ? pr.reference_id : null,
          event_request_id: pr.reference_type === 'event_hosting_request' ? pr.reference_id : null,
        }).select().single();

        // Try to match payer to person for future auto-matching
        if (capture.payer_name && pr.person_id) {
          await supabase.from('payment_sender_mappings').upsert({
            sender_name: capture.payer_name,
            sender_name_normalized: capture.payer_name.toLowerCase().trim(),
            person_id: pr.person_id,
            confidence_score: 1.0,
            match_source: 'paypal_checkout',
            updated_at: new Date().toISOString(),
          }, { onConflict: 'sender_name_normalized' });
        }

        // Log API usage — actual cost: 2.99% + $0.49 per transaction
        const fee = capture.amount * 0.0299 + 0.49;
        await supabase.from('api_usage_log').insert({
          vendor: 'paypal',
          category: 'paypal_payment_processing',
          endpoint: 'v2/checkout/orders/capture',
          units: 1,
          unit_type: 'transactions',
          estimated_cost_usd: parseFloat(fee.toFixed(4)),
          metadata: {
            order_id,
            capture_id: capture.capture_id,
            amount: capture.amount,
            payer: capture.payer_email,
          },
        });

        return new Response(
          JSON.stringify({
            success: true,
            capture_id: capture.capture_id,
            amount: capture.amount,
            payer_email: capture.payer_email,
            payer_name: capture.payer_name,
            ledger_id: ledgerEntry?.id,
            payment_record_id: pr.id,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({
          success: capture.status === 'COMPLETED',
          status: capture.status,
          error: capture.status !== 'COMPLETED' ? `Payment status: ${capture.status}` : undefined,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ---- GET CONFIG (client ID for JS SDK) ----
    if (action === 'get_config') {
      const clientId = config.test_mode ? config.sandbox_client_id : config.client_id;
      return new Response(
        JSON.stringify({
          success: true,
          client_id: clientId,
          test_mode: config.test_mode,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: `Unknown action: ${action}. Use create_order, capture_order, or get_config.` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('PayPal checkout error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

/**
 * Map our payment_type to ledger category
 */
function mapPaymentTypeToCategory(paymentType: string | null): string {
  const map: Record<string, string> = {
    rent: 'rent',
    prorated_rent: 'prorated_rent',
    security_deposit: 'security_deposit',
    move_in_deposit: 'move_in_deposit',
    reservation_deposit: 'reservation_deposit',
    application_fee: 'application_fee',
    event_rental_fee: 'event_rental_fee',
    event_reservation_deposit: 'event_reservation_deposit',
    event_cleaning_deposit: 'event_cleaning_deposit',
    late_fee: 'late_fee',
  };
  return map[paymentType || ''] || 'other';
}
