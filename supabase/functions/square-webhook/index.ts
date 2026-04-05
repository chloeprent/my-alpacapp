/**
 * Square Webhook Handler
 *
 * Receives webhook notifications from Square for payment and refund status changes.
 * Critical for ACH/bank transfer payments which are asynchronous (PENDING → COMPLETED/FAILED).
 * Updates square_payments and ledger tables, sends admin notifications.
 *
 * Deploy with: supabase functions deploy square-webhook --no-verify-jwt
 * Webhook URL: YOUR_SUPABASE_URL/functions/v1/square-webhook
 *
 * Events handled:
 * - payment.created → log receipt, update source type
 * - payment.updated → status transition (COMPLETED/FAILED) + admin notification
 * - refund.created → log refund initiation
 * - refund.updated → refund status change
 *
 * Register webhooks in Square Developer Console:
 * https://developer.squareup.com/apps → Webhooks → Add subscription
 * Copy the Signature Key → store in square_config.webhook_signature_key
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-square-hmacsha256-signature'
};

const PAYMENTS_EMAIL = 'payments@YOUR_DOMAIN';

interface SquareWebhookEvent {
  merchant_id: string;
  type: string;
  event_id: string;
  created_at: string;
  data: {
    type: string;
    id: string;
    object: {
      payment?: SquarePayment;
      refund?: SquareRefund;
    };
  };
}

interface SquarePayment {
  id: string;
  created_at: string;
  updated_at: string;
  amount_money: { amount: number; currency: string };
  status: string; // PENDING, COMPLETED, FAILED, CANCELED
  source_type: string; // CARD, BANK_ACCOUNT, etc.
  location_id: string;
  order_id?: string;
  receipt_url?: string;
  note?: string;
  buyer_email_address?: string;
  bank_account_details?: {
    bank_name?: string;
    transfer_type?: string;
    account_ownership_type?: string;
    ach_details?: {
      routing_number?: string;
      account_number_suffix?: string;
      account_type?: string;
    };
  };
  card_details?: {
    card?: {
      card_brand?: string;
      last_4?: string;
    };
  };
}

interface SquareRefund {
  id: string;
  payment_id: string;
  amount_money: { amount: number; currency: string };
  status: string; // PENDING, COMPLETED, FAILED, REJECTED
  reason?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Verify Square webhook HMAC-SHA256 signature.
 * Square signs: HMAC-SHA256(signatureKey, notificationUrl + rawBody)
 */
async function verifySquareWebhook(
  rawBody: string,
  signatureHeader: string | null,
  signatureKey: string,
  notificationUrl: string
): Promise<boolean> {
  if (!signatureHeader || !signatureKey) return false;

  const payload = notificationUrl + rawBody;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signatureKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload)
  );

  // Square expects base64 comparison
  const expectedBase64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return expectedBase64 === signatureHeader;
}

function formatCurrency(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}

/** Send admin notification email about ACH payment status change */
async function sendPaymentStatusEmail(
  supabase: ReturnType<typeof createClient>,
  payment: SquarePayment,
  newStatus: string,
  failureReason?: string
): Promise<void> {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  if (!RESEND_API_KEY) {
    console.warn('No RESEND_API_KEY, skipping notification email');
    return;
  }

  const amount = formatCurrency(payment.amount_money.amount);
  const sourceType = payment.source_type === 'BANK_ACCOUNT' ? 'ACH Bank Transfer' : payment.source_type;
  const isSuccess = newStatus === 'COMPLETED';

  let bankInfo = '';
  if (payment.bank_account_details) {
    const bd = payment.bank_account_details;
    const suffix = bd.ach_details?.account_number_suffix || '****';
    bankInfo = ` (${bd.bank_name || 'Bank'} ****${suffix})`;
  }

  const subject = isSuccess
    ? `[Square ACH] ${amount} payment COMPLETED${bankInfo}`
    : `[Square ACH] ${amount} payment FAILED${bankInfo}`;

  const statusColor = isSuccess ? '#2e7d32' : '#c62828';
  const statusIcon = isSuccess ? '✓' : '✗';

  const html = `
    <div style="max-width:560px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="background:${statusColor};padding:20px;text-align:center;border-radius:8px 8px 0 0;">
        <span style="font-size:28px;color:white;">${statusIcon}</span>
        <h2 style="color:white;margin:8px 0 0;">Square Payment ${newStatus}</h2>
      </div>
      <div style="padding:24px;background:white;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
        <table style="width:100%;font-size:14px;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#888;">Amount</td><td style="padding:8px 0;font-weight:600;">${amount}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Source</td><td style="padding:8px 0;">${sourceType}${bankInfo}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Status</td><td style="padding:8px 0;color:${statusColor};font-weight:600;">${newStatus}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Square ID</td><td style="padding:8px 0;font-family:monospace;font-size:12px;">${payment.id}</td></tr>
          ${payment.buyer_email_address ? `<tr><td style="padding:8px 0;color:#888;">Buyer Email</td><td style="padding:8px 0;">${payment.buyer_email_address}</td></tr>` : ''}
          ${payment.note ? `<tr><td style="padding:8px 0;color:#888;">Note</td><td style="padding:8px 0;">${payment.note}</td></tr>` : ''}
          ${failureReason ? `<tr><td style="padding:8px 0;color:#888;">Failure Reason</td><td style="padding:8px 0;color:#c62828;">${failureReason}</td></tr>` : ''}
        </table>
        <p style="margin-top:16px;font-size:13px;color:#888;">
          ${isSuccess
            ? 'Funds have been received. The ledger has been updated automatically.'
            : 'The payment has failed. The ledger entry has been marked as failed. Follow up with the payer.'}
        </p>
      </div>
    </div>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Property System <auto@YOUR_DOMAIN>',
        to: [PAYMENTS_EMAIL],
        subject,
        html,
      }),
    });

    if (res.ok) {
      console.log(`Payment status email sent to ${PAYMENTS_EMAIL}`);
    } else {
      const err = await res.json();
      console.error('Failed to send payment status email:', err);
    }
  } catch (err) {
    console.error('Error sending payment status email:', err);
  }

  // Log email API usage
  await supabase.from('api_usage_log').insert({
    vendor: 'resend',
    category: 'email_payment_receipt',
    endpoint: 'emails',
    units: 1,
    unit_type: 'emails',
    estimated_cost_usd: 0.00028,
    metadata: { square_payment_id: payment.id, status: newStatus },
  });
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Read raw body BEFORE parsing (required for signature verification)
  const rawBody = await req.text();
  const signatureHeader = req.headers.get('x-square-hmacsha256-signature');

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Load Square config for webhook signature key
    const { data: config, error: configError } = await supabase
      .from('square_config')
      .select('webhook_signature_key, test_mode')
      .single();

    if (configError || !config) {
      console.error('Square config not found:', configError);
      return new Response(
        JSON.stringify({ error: 'Square config not found' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify webhook signature
    const notificationUrl = `${supabaseUrl}/functions/v1/square-webhook`;

    if (config.webhook_signature_key) {
      const isValid = await verifySquareWebhook(
        rawBody,
        signatureHeader,
        config.webhook_signature_key,
        notificationUrl
      );

      if (!isValid) {
        console.error('Square webhook signature verification failed');
        return new Response(
          JSON.stringify({ error: 'Webhook signature verification failed' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      console.log('Square webhook signature verified');
    } else {
      console.warn('No webhook_signature_key configured — skipping signature verification');
    }

    // Parse the event
    const event = JSON.parse(rawBody) as SquareWebhookEvent;
    console.log('Square webhook event:', event.type, event.event_id);

    // Log webhook receipt to api_usage_log
    await supabase.from('api_usage_log').insert({
      vendor: 'square',
      category: 'square_webhook',
      endpoint: event.type,
      units: 1,
      unit_type: 'webhook_events',
      estimated_cost_usd: 0,
      metadata: {
        event_id: event.event_id,
        merchant_id: event.merchant_id,
        data_id: event.data?.id,
      },
    });

    switch (event.type) {
      // ─── payment.created ──────────────────────────────────
      case 'payment.created': {
        const payment = event.data.object.payment;
        if (!payment) {
          console.warn('payment.created event has no payment object');
          break;
        }

        console.log('Payment created:', {
          id: payment.id,
          status: payment.status,
          source_type: payment.source_type,
          amount: payment.amount_money.amount,
        });

        // Find matching square_payments record by square_payment_id
        const { data: records } = await supabase
          .from('square_payments')
          .select('id, status, square_source_type')
          .eq('square_payment_id', payment.id);

        if (records?.length) {
          // Update source type if not already set
          for (const record of records) {
            if (!record.square_source_type) {
              await supabase.from('square_payments').update({
                square_source_type: payment.source_type,
                square_event_id: event.event_id,
                updated_at: new Date().toISOString(),
              }).eq('id', record.id);
            }
          }
        } else {
          console.log(`No matching square_payments record for Square payment ${payment.id} — may be a POS/Terminal/Invoice payment`);
        }
        break;
      }

      // ─── payment.updated ──────────────────────────────────
      case 'payment.updated': {
        const payment = event.data.object.payment;
        if (!payment) {
          console.warn('payment.updated event has no payment object');
          break;
        }

        console.log('Payment updated:', {
          id: payment.id,
          status: payment.status,
          source_type: payment.source_type,
          amount: payment.amount_money.amount,
        });

        // Find matching square_payments record
        const { data: records } = await supabase
          .from('square_payments')
          .select('id, status, square_event_id')
          .eq('square_payment_id', payment.id);

        if (!records?.length) {
          console.log(`No matching square_payments record for Square payment ${payment.id}`);
          break;
        }

        for (const record of records) {
          // Dedup: skip if we've already processed this event
          if (record.square_event_id === event.event_id) {
            console.log(`Already processed event ${event.event_id} for record ${record.id}, skipping`);
            continue;
          }

          const now = new Date().toISOString();

          if (payment.status === 'COMPLETED') {
            // ── Payment COMPLETED ──
            await supabase.from('square_payments').update({
              status: 'completed',
              square_source_type: payment.source_type,
              square_event_id: event.event_id,
              completed_at: now,
              square_receipt_url: payment.receipt_url || null,
              updated_at: now,
            }).eq('id', record.id);

            // Update linked ledger entry
            const { data: ledgerEntries } = await supabase
              .from('ledger')
              .select('id, status')
              .eq('square_payment_id', record.id);

            if (ledgerEntries?.length) {
              for (const entry of ledgerEntries) {
                if (entry.status !== 'completed') {
                  await supabase.from('ledger').update({
                    status: 'completed',
                    updated_at: now,
                  }).eq('id', entry.id);
                  console.log(`Ledger entry ${entry.id} updated to completed`);
                }
              }
            }

            console.log(`Square payment ${payment.id} → COMPLETED`);

            // Send notification for ACH payments (card payments complete instantly so less interesting)
            if (payment.source_type === 'BANK_ACCOUNT') {
              await sendPaymentStatusEmail(supabase, payment, 'COMPLETED');
            }

          } else if (payment.status === 'FAILED') {
            // ── Payment FAILED ──
            const failureReason = 'Bank transfer failed — insufficient funds or invalid account';

            await supabase.from('square_payments').update({
              status: 'failed',
              square_source_type: payment.source_type,
              square_event_id: event.event_id,
              failed_at: now,
              failure_reason: failureReason,
              updated_at: now,
            }).eq('id', record.id);

            // Update linked ledger entry
            const { data: ledgerEntries } = await supabase
              .from('ledger')
              .select('id, status')
              .eq('square_payment_id', record.id);

            if (ledgerEntries?.length) {
              for (const entry of ledgerEntries) {
                await supabase.from('ledger').update({
                  status: 'failed',
                  updated_at: now,
                }).eq('id', entry.id);
                console.log(`Ledger entry ${entry.id} updated to failed`);
              }
            }

            console.log(`Square payment ${payment.id} → FAILED: ${failureReason}`);

            // Always notify on failures
            await sendPaymentStatusEmail(supabase, payment, 'FAILED', failureReason);

          } else if (payment.status === 'CANCELED') {
            // ── Payment CANCELED ──
            await supabase.from('square_payments').update({
              status: 'failed',
              square_source_type: payment.source_type,
              square_event_id: event.event_id,
              failed_at: now,
              failure_reason: 'Payment canceled',
              updated_at: now,
            }).eq('id', record.id);

            // Update linked ledger entry
            const { data: ledgerEntries } = await supabase
              .from('ledger')
              .select('id, status')
              .eq('square_payment_id', record.id);

            if (ledgerEntries?.length) {
              for (const entry of ledgerEntries) {
                await supabase.from('ledger').update({
                  status: 'failed',
                  updated_at: now,
                }).eq('id', entry.id);
              }
            }

            console.log(`Square payment ${payment.id} → CANCELED`);
            await sendPaymentStatusEmail(supabase, payment, 'CANCELED', 'Payment was canceled');

          } else {
            // Other status (PENDING, APPROVED, etc.)
            await supabase.from('square_payments').update({
              square_source_type: payment.source_type,
              square_event_id: event.event_id,
              updated_at: now,
            }).eq('id', record.id);
            console.log(`Square payment ${payment.id} status: ${payment.status} (no action needed)`);
          }
        }
        break;
      }

      // ─── refund.created ──────────────────────────────────
      case 'refund.created': {
        const refund = event.data.object.refund;
        if (!refund) break;

        console.log('Refund created:', {
          id: refund.id,
          payment_id: refund.payment_id,
          amount: refund.amount_money.amount,
          status: refund.status,
        });

        // Update square_payments refund fields if we have a matching record
        const { data: records } = await supabase
          .from('square_payments')
          .select('id')
          .eq('square_payment_id', refund.payment_id);

        if (records?.length) {
          for (const record of records) {
            await supabase.from('square_payments').update({
              refund_id: refund.id,
              refund_amount: refund.amount_money.amount / 100,
              refunded_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }).eq('id', record.id);
          }
          console.log(`Refund ${refund.id} linked to payment ${refund.payment_id}`);
        }
        break;
      }

      // ─── refund.updated ──────────────────────────────────
      case 'refund.updated': {
        const refund = event.data.object.refund;
        if (!refund) break;

        console.log('Refund updated:', {
          id: refund.id,
          payment_id: refund.payment_id,
          status: refund.status,
        });

        if (refund.status === 'COMPLETED') {
          // Find the original payment record
          const { data: records } = await supabase
            .from('square_payments')
            .select('id')
            .eq('square_payment_id', refund.payment_id);

          if (records?.length) {
            for (const record of records) {
              // Update the square_payments record
              await supabase.from('square_payments').update({
                status: 'refunded',
                updated_at: new Date().toISOString(),
              }).eq('id', record.id);

              // Find and update the linked ledger entry for the refund
              const { data: refundLedger } = await supabase
                .from('ledger')
                .select('id')
                .eq('square_refund_id', refund.id);

              if (refundLedger?.length) {
                for (const entry of refundLedger) {
                  await supabase.from('ledger').update({
                    status: 'completed',
                    updated_at: new Date().toISOString(),
                  }).eq('id', entry.id);
                }
              }
            }
          }
          console.log(`Refund ${refund.id} completed for payment ${refund.payment_id}`);
        } else if (refund.status === 'FAILED' || refund.status === 'REJECTED') {
          console.warn(`Refund ${refund.id} ${refund.status} for payment ${refund.payment_id}`);
        }
        break;
      }

      default:
        console.log('Unhandled Square webhook event type:', event.type);
    }

    return new Response(
      JSON.stringify({ received: true, type: event.type }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Square webhook error:', error);
    // Return 200 to prevent Square from retrying
    return new Response(
      JSON.stringify({
        received: true,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
