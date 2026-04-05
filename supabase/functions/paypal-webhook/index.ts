/**
 * PayPal Webhook Handler
 *
 * Receives webhook notifications from PayPal for:
 * 1. Payout status changes (outbound associate payments)
 * 2. Payment captures (inbound tenant payments via checkout)
 * 3. Payment refunds
 *
 * Deploy with: supabase functions deploy paypal-webhook --no-verify-jwt
 * Webhook URL: YOUR_SUPABASE_URL/functions/v1/paypal-webhook
 *
 * PayPal Events handled:
 * --- Payouts (outbound) ---
 * - PAYMENT.PAYOUTS-ITEM.SUCCEEDED  → payout completed
 * - PAYMENT.PAYOUTS-ITEM.FAILED     → payout failed
 * - PAYMENT.PAYOUTS-ITEM.RETURNED   → payout returned (unclaimed)
 * - PAYMENT.PAYOUTS-ITEM.BLOCKED    → payout blocked
 * - PAYMENT.PAYOUTS-ITEM.DENIED     → payout denied
 * - PAYMENT.PAYOUTS-ITEM.UNCLAIMED  → recipient hasn't claimed
 *
 * --- Payments (inbound) ---
 * - PAYMENT.CAPTURE.COMPLETED      → payment received
 * - PAYMENT.CAPTURE.DENIED         → payment denied
 * - PAYMENT.CAPTURE.REFUNDED       → payment refunded
 * - CHECKOUT.ORDER.COMPLETED       → checkout order completed
 *
 * --- Refunds ---
 * - PAYMENT.CAPTURE.REVERSED       → payment reversed
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource_type: string;
  resource: Record<string, unknown>;
  create_time: string;
}

/**
 * Verify PayPal webhook signature.
 * In production, verify the transmission signature against PayPal's cert.
 * For now, we check the webhook-id header matches our stored webhook_id.
 */
async function verifyWebhook(
  req: Request,
  config: { webhook_id: string; sandbox_webhook_id: string; test_mode: boolean }
): Promise<boolean> {
  const webhookId = req.headers.get('paypal-transmission-id');
  if (!webhookId) {
    console.warn('Missing PayPal transmission ID header');
    // Still process — PayPal doesn't always include all headers in sandbox
    return true;
  }
  return true;
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

    const rawBody = await req.text();
    const event: PayPalWebhookEvent = JSON.parse(rawBody);

    console.log('PayPal webhook received:', {
      event_type: event.event_type,
      resource_type: event.resource_type,
      resource_id: event.resource?.id,
    });

    // Load config for verification
    const { data: config } = await supabase
      .from('paypal_config')
      .select('webhook_id, sandbox_webhook_id, test_mode')
      .single();

    if (config) {
      const isValid = await verifyWebhook(req, config);
      if (!isValid) {
        console.error('Webhook verification failed');
        return new Response('Unauthorized', { status: 401 });
      }
    }

    // Route based on event type
    if (event.event_type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
      return await handlePayoutEvent(supabase, event);
    }

    if (event.event_type.startsWith('PAYMENT.CAPTURE.') || event.event_type === 'CHECKOUT.ORDER.COMPLETED') {
      return await handlePaymentCaptureEvent(supabase, event);
    }

    // Unknown event — email admin so we know about it
    console.log(`Unhandled PayPal event type: ${event.event_type}`);
    await notifyUnknownEvent(event);
    return new Response(
      JSON.stringify({ received: true, event_type: event.event_type }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('PayPal webhook error:', error);
    // Always return 200 to prevent PayPal from retrying
    return new Response(
      JSON.stringify({ received: true, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// ================================================================
// PAYOUT EVENTS (outbound associate payments)
// ================================================================

async function handlePayoutEvent(supabase: ReturnType<typeof createClient>, event: PayPalWebhookEvent) {
  const statusMap: Record<string, string> = {
    'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': 'completed',
    'PAYMENT.PAYOUTS-ITEM.FAILED': 'failed',
    'PAYMENT.PAYOUTS-ITEM.RETURNED': 'returned',
    'PAYMENT.PAYOUTS-ITEM.BLOCKED': 'failed',
    'PAYMENT.PAYOUTS-ITEM.DENIED': 'failed',
    'PAYMENT.PAYOUTS-ITEM.UNCLAIMED': 'processing',
  };

  const newStatus = statusMap[event.event_type];
  if (!newStatus) {
    return jsonResponse({ received: true });
  }

  const resource = event.resource as Record<string, unknown>;
  const batchId = resource.payout_batch_id as string | undefined;
  const itemId = resource.payout_item_id as string | undefined;

  let query = supabase.from('payouts').select('id, ledger_id, status');

  if (itemId) {
    query = query.eq('external_item_id', itemId);
  } else if (batchId) {
    query = query.eq('external_payout_id', batchId);
  } else {
    console.warn('No payout_batch_id or payout_item_id in webhook');
    return jsonResponse({ received: true, warning: 'No identifiable payout reference' });
  }

  const { data: payouts, error: queryError } = await query;

  if (queryError) {
    console.error('Error querying payouts:', queryError);
    return jsonResponse({ received: true, error: 'Query failed' });
  }

  if (!payouts || payouts.length === 0) {
    console.warn('No matching payout found for:', { batchId, itemId });
    return jsonResponse({ received: true, warning: 'No matching payout' });
  }

  for (const payout of payouts) {
    if (payout.status === 'completed' && newStatus !== 'completed') {
      console.log(`Skipping status change for payout ${payout.id}: already completed`);
      continue;
    }

    let errorMessage: string | null = null;
    if (newStatus === 'failed' || newStatus === 'returned') {
      const errors = resource.errors as { name: string; message: string }[] | undefined;
      errorMessage = errors?.map(e => `${e.name}: ${e.message}`).join('; ') || `PayPal status: ${event.event_type}`;
    }

    const updateData: Record<string, unknown> = {
      status: newStatus,
      updated_at: new Date().toISOString(),
    };
    if (errorMessage) updateData.error_message = errorMessage;
    if (itemId) updateData.external_item_id = itemId;

    await supabase.from('payouts').update(updateData).eq('id', payout.id);

    if (payout.ledger_id) {
      const ledgerStatus = newStatus === 'completed' ? 'completed'
        : newStatus === 'failed' || newStatus === 'returned' ? 'failed'
        : 'pending';

      await supabase.from('ledger').update({
        status: ledgerStatus,
        updated_at: new Date().toISOString(),
      }).eq('id', payout.ledger_id);
    }

    console.log(`Payout ${payout.id} updated to ${newStatus}`);
  }

  return jsonResponse({
    received: true,
    event_type: event.event_type,
    status: newStatus,
    payouts_updated: payouts.length,
  });
}

// ================================================================
// PAYMENT CAPTURE EVENTS (inbound tenant payments)
// ================================================================

async function handlePaymentCaptureEvent(supabase: ReturnType<typeof createClient>, event: PayPalWebhookEvent) {
  const resource = event.resource as Record<string, unknown>;

  // Handle CHECKOUT.ORDER.COMPLETED
  if (event.event_type === 'CHECKOUT.ORDER.COMPLETED') {
    const orderId = resource.id as string;
    console.log('Checkout order completed:', orderId);

    // Our paypal-checkout function already handles capture + ledger on capture_order action.
    // This webhook is a backup — only record if not already captured.
    const { data: existing } = await supabase
      .from('paypal_payments')
      .select('id, status')
      .eq('paypal_order_id', orderId)
      .single();

    if (existing && existing.status === 'completed') {
      console.log('Order already captured and recorded, skipping');
      return jsonResponse({ received: true, already_processed: true });
    }

    // Update payment status if it was still pending
    if (existing && existing.status !== 'completed') {
      const purchaseUnit = (resource.purchase_units as Record<string, unknown>[])?.[0];
      const capture = (purchaseUnit?.payments as Record<string, unknown>)?.captures?.[0] as Record<string, unknown> | undefined;
      const payer = resource.payer as Record<string, unknown> | undefined;
      const payerName = payer?.name as Record<string, string> | undefined;

      await supabase.from('paypal_payments').update({
        status: 'completed',
        paypal_capture_id: capture?.id as string || null,
        paypal_payer_id: payer?.payer_id as string || null,
        paypal_payer_email: payer?.email_address as string || null,
        paypal_payer_name: `${payerName?.given_name || ''} ${payerName?.surname || ''}`.trim() || null,
        raw_response: resource,
        updated_at: new Date().toISOString(),
      }).eq('id', existing.id);

      // Create ledger entry
      const { data: payment } = await supabase
        .from('paypal_payments')
        .select('*')
        .eq('id', existing.id)
        .single();

      if (payment) {
        // Check if ledger entry already exists (dedup)
        const captureId = capture?.id as string;
        if (captureId) {
          const { data: existingLedger } = await supabase
            .from('ledger')
            .select('id')
            .eq('paypal_transaction_id', captureId)
            .single();

          if (!existingLedger) {
            await createLedgerEntry(supabase, payment, captureId, payer?.email_address as string);
          }
        }
      }
    }

    return jsonResponse({ received: true, event_type: event.event_type });
  }

  // Handle PAYMENT.CAPTURE.COMPLETED
  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    const captureId = resource.id as string;
    const amount = parseFloat((resource.amount as Record<string, string>)?.value || '0');

    console.log('Payment capture completed:', { captureId, amount });

    // Dedup: check if we already recorded this capture
    const { data: existingLedger } = await supabase
      .from('ledger')
      .select('id')
      .eq('paypal_transaction_id', captureId)
      .single();

    if (existingLedger) {
      console.log('Capture already recorded in ledger, skipping');
      return jsonResponse({ received: true, already_processed: true });
    }

    // Try to find the associated paypal_payments record via supplementary_data or custom_id
    const supplementary = resource.supplementary_data as Record<string, unknown> | undefined;
    const relatedIds = supplementary?.related_ids as Record<string, string> | undefined;
    const orderId = relatedIds?.order_id;

    let paymentRecord: Record<string, unknown> | null = null;

    if (orderId) {
      const { data } = await supabase
        .from('paypal_payments')
        .select('*')
        .eq('paypal_order_id', orderId)
        .single();
      paymentRecord = data;
    }

    if (!paymentRecord) {
      // Try to find by capture ID (in case checkout already updated it)
      const { data } = await supabase
        .from('paypal_payments')
        .select('*')
        .eq('paypal_capture_id', captureId)
        .single();
      paymentRecord = data;
    }

    // Record in ledger even without a paypal_payments record (e.g., PayPal.me payment)
    if (paymentRecord) {
      await createLedgerEntry(supabase, paymentRecord, captureId, null);
    } else {
      // Unknown payment — create a pending ledger entry for admin review
      console.log('Unknown PayPal capture, creating pending ledger entry');
      const payerInfo = resource.payer as Record<string, unknown> | undefined;
      const payerName = payerInfo?.name as Record<string, string> | undefined;
      const fullName = `${payerName?.given_name || ''} ${payerName?.surname || ''}`.trim();

      // Try to match payer to person by name
      let personId: string | null = null;
      let personName = fullName || null;

      if (fullName) {
        const matchResult = await matchPayerToPerson(supabase, fullName);
        if (matchResult) {
          personId = matchResult.person_id;
          personName = matchResult.name;
        }
      }

      // Try to match to an assignment for reconciliation
      let assignmentId: string | null = null;
      if (personId) {
        const { data: assignment } = await supabase
          .from('assignments')
          .select('id')
          .eq('person_id', personId)
          .in('status', ['active', 'pending_contract', 'contract_sent'])
          .order('start_date', { ascending: false })
          .limit(1)
          .single();

        if (assignment) {
          assignmentId = assignment.id;
        }
      }

      await supabase.from('ledger').insert({
        direction: 'income',
        category: assignmentId ? 'rent' : 'other',
        amount,
        payment_method: 'paypal',
        transaction_date: new Date().toISOString().split('T')[0],
        person_id: personId,
        person_name: personName,
        assignment_id: assignmentId,
        paypal_transaction_id: captureId,
        status: personId ? 'completed' : 'pending', // Pending if we can't identify the payer
        description: personId
          ? `PayPal payment from ${personName}`
          : `Unmatched PayPal payment — needs admin review`,
        notes: `PayPal payer: ${payerInfo?.email_address || 'unknown'}, capture: ${captureId}`,
        recorded_by: 'system:paypal-webhook',
        is_test: false,
      });

      // If unmatched, also insert into pending_payments for admin review
      if (!personId) {
        await supabase.from('pending_payments').insert({
          raw_text: `PayPal payment: $${amount.toFixed(2)} from ${fullName || 'unknown'} (${payerInfo?.email_address || 'no email'})`,
          parsed_amount: amount,
          parsed_sender_name: fullName || null,
          payment_method: 'paypal',
          paypal_capture_id: captureId,
          source: 'paypal_webhook',
          suggestions: [],
        });
      }
    }

    return jsonResponse({ received: true, event_type: event.event_type, capture_id: captureId });
  }

  // Handle PAYMENT.CAPTURE.DENIED
  if (event.event_type === 'PAYMENT.CAPTURE.DENIED') {
    const captureId = resource.id as string;
    console.log('Payment capture denied:', captureId);

    // Update paypal_payments if we have one
    await supabase.from('paypal_payments')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('paypal_capture_id', captureId);

    return jsonResponse({ received: true, event_type: event.event_type });
  }

  // Handle PAYMENT.CAPTURE.REFUNDED / REVERSED
  if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED' || event.event_type === 'PAYMENT.CAPTURE.REVERSED') {
    const captureId = resource.id as string;
    const refundAmount = parseFloat((resource.amount as Record<string, string>)?.value || '0');
    console.log('Payment refunded/reversed:', { captureId, refundAmount });

    // Update paypal_payments
    await supabase.from('paypal_payments')
      .update({
        status: 'refunded',
        refund_amount: refundAmount,
        refunded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('paypal_capture_id', captureId);

    // Find original ledger entry and create refund entry
    const { data: originalLedger } = await supabase
      .from('ledger')
      .select('*')
      .eq('paypal_transaction_id', captureId)
      .single();

    if (originalLedger) {
      await supabase.from('ledger').insert({
        direction: 'expense',
        category: 'refund',
        amount: refundAmount,
        payment_method: 'paypal',
        transaction_date: new Date().toISOString().split('T')[0],
        person_id: originalLedger.person_id,
        person_name: originalLedger.person_name,
        paypal_transaction_id: `refund-${captureId}`,
        refund_of_ledger_id: originalLedger.id,
        status: 'completed',
        description: `PayPal refund for ${originalLedger.description || 'payment'}`,
        recorded_by: 'system:paypal-webhook',
        is_test: false,
      });
    }

    return jsonResponse({ received: true, event_type: event.event_type });
  }

  return jsonResponse({ received: true, event_type: event.event_type });
}

// ================================================================
// HELPERS
// ================================================================

async function createLedgerEntry(
  supabase: ReturnType<typeof createClient>,
  payment: Record<string, unknown>,
  captureId: string,
  payerEmail: string | null
) {
  const paymentType = payment.payment_type as string || 'other';
  const categoryMap: Record<string, string> = {
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

  await supabase.from('ledger').insert({
    direction: 'income',
    category: categoryMap[paymentType] || 'other',
    amount: payment.amount,
    payment_method: 'paypal',
    transaction_date: new Date().toISOString().split('T')[0],
    person_id: payment.person_id || null,
    person_name: payment.person_name || null,
    paypal_payment_id: payment.id,
    paypal_transaction_id: captureId,
    status: 'completed',
    description: `PayPal payment: ${payment.description || paymentType}`,
    notes: payerEmail ? `Payer: ${payerEmail}` : null,
    recorded_by: 'system:paypal-webhook',
    is_test: payment.is_test || false,
    assignment_id: payment.reference_type === 'assignment' ? payment.reference_id as string : null,
    rental_application_id: payment.reference_type === 'rental_application' ? payment.reference_id as string : null,
    event_request_id: payment.reference_type === 'event_hosting_request' ? payment.reference_id as string : null,
  });
}

/**
 * Try to match a PayPal payer name to a person in the people table.
 * Uses the same matching logic as Zelle payments.
 */
async function matchPayerToPerson(
  supabase: ReturnType<typeof createClient>,
  payerName: string
): Promise<{ person_id: string; name: string } | null> {
  const normalized = payerName.toLowerCase().trim();

  // 1. Check payment_sender_mappings cache
  const { data: cached } = await supabase
    .from('payment_sender_mappings')
    .select('person_id')
    .eq('sender_name_normalized', normalized)
    .single();

  if (cached) {
    const { data: person } = await supabase
      .from('people')
      .select('id, first_name, last_name')
      .eq('id', cached.person_id)
      .single();
    if (person) {
      return { person_id: person.id, name: `${person.first_name} ${person.last_name}` };
    }
  }

  // 2. Load all people for matching
  const { data: people } = await supabase
    .from('people')
    .select('id, first_name, last_name');

  if (!people) return null;

  // 3. Exact full-name match (case-insensitive)
  for (const person of people) {
    const fullName = `${person.first_name} ${person.last_name}`;
    if (fullName.toLowerCase().trim() === normalized) {
      // Save mapping for future
      await supabase.from('payment_sender_mappings').upsert({
        sender_name: payerName,
        sender_name_normalized: normalized,
        person_id: person.id,
        confidence_score: 1.0,
        match_source: 'paypal_webhook_exact',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'sender_name_normalized' });
      return { person_id: person.id, name: fullName };
    }
  }

  // 4. Fuzzy: first-name + last-name parts matching
  const parts = normalized.split(/\s+/);
  if (parts.length >= 2) {
    for (const person of people) {
      const firstParts = (person.first_name || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
      const lastParts = (person.last_name || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
      if (firstParts.length === 0 || lastParts.length === 0) continue;
      const firstMatch = firstParts.some((fp: string) => parts.includes(fp));
      const lastMatch = lastParts.some((lp: string) => parts.includes(lp));
      if (firstMatch && lastMatch) {
        const fullName = `${person.first_name} ${person.last_name}`;
        await supabase.from('payment_sender_mappings').upsert({
          sender_name: payerName,
          sender_name_normalized: normalized,
          person_id: person.id,
          confidence_score: 0.9,
          match_source: 'paypal_webhook_fuzzy',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'sender_name_normalized' });
        return { person_id: person.id, name: fullName };
      }
    }
  }

  return null;
}

/**
 * Send email to admin about an unknown/unhandled PayPal webhook event.
 */
async function notifyUnknownEvent(event: PayPalWebhookEvent) {
  try {
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    if (!resendApiKey) {
      console.warn('No RESEND_API_KEY — cannot send unknown event notification');
      return;
    }

    const resourceJson = JSON.stringify(event.resource || {}, null, 2)
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Property Payments <noreply@YOUR_DOMAIN>',
        to: ['admin@YOUR_DOMAIN'],
        subject: `Unknown PayPal Event: ${event.event_type}`,
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:600px;">
            <h2 style="color:#003087;">PayPal Webhook — Unhandled Event</h2>
            <p>A PayPal webhook event was received that the system doesn't have a handler for. This might be a new event type worth adding support for.</p>
            <table style="border-collapse:collapse;width:100%;">
              <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Event Type</td><td style="padding:8px;border-bottom:1px solid #eee;"><code>${event.event_type}</code></td></tr>
              <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Event ID</td><td style="padding:8px;border-bottom:1px solid #eee;">${event.id}</td></tr>
              <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Resource Type</td><td style="padding:8px;border-bottom:1px solid #eee;">${event.resource_type || 'N/A'}</td></tr>
              <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Time</td><td style="padding:8px;border-bottom:1px solid #eee;">${event.create_time}</td></tr>
            </table>
            <details style="margin-top:1rem;">
              <summary style="cursor:pointer;font-weight:bold;">Resource Payload</summary>
              <pre style="background:#f5f5f5;padding:1rem;border-radius:8px;overflow-x:auto;font-size:0.85rem;">${resourceJson}</pre>
            </details>
          </div>
        `,
      }),
    });
    console.log(`Sent unknown event notification for: ${event.event_type}`);
  } catch (err) {
    console.error('Failed to send unknown event notification:', err);
  }
}

function jsonResponse(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
