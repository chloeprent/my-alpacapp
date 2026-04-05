/**
 * Stripe Webhook Handler
 *
 * Receives webhook notifications from Stripe for transfer and payment status.
 * Updates payouts table (and optionally stripe_payments) and ledger accordingly.
 * On payment success, sends a rich confirmation email to the payer with a statement
 * summary showing what was paid, prior payments, and remaining balance.
 * Also forwards to payments@YOUR_DOMAIN.
 *
 * Deploy with: supabase functions deploy stripe-webhook --no-verify-jwt
 * Webhook URL: YOUR_SUPABASE_URL/functions/v1/stripe-webhook
 *
 * Events handled:
 * - transfer.paid → payout completed
 * - transfer.failed → payout failed
 * - transfer.reversed → payout returned
 * - payment_intent.succeeded → inbound payment completed + confirmation email
 * - payment_intent.payment_failed → inbound payment failed
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature'
};

const PAYMENTS_EMAIL = 'payments@YOUR_DOMAIN';

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

function parseStripeSignature(header: string | null): { t: string; v1: string } | null {
  if (!header) return null;
  const parts = header.split(',');
  let t = '';
  let v1 = '';
  for (const part of parts) {
    const [key, val] = part.split('=');
    if (key?.trim() === 't') t = val?.trim() ?? '';
    if (key?.trim() === 'v1') v1 = val?.trim() ?? '';
  }
  return t && v1 ? { t, v1 } : null;
}

async function verifyStripeWebhook(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  const parsed = parseStripeSignature(signature);
  if (!parsed) return false;
  const { t, v1 } = parsed;
  const signedPayload = `${t}.${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signedPayload)
  );
  const expectedHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return expectedHex === v1;
}

function formatCurrency(amount: number): string {
  return `$${Number(amount).toFixed(2).replace(/\.00$/, '')}`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Compute rent due dates for an assignment (same logic as payment-overdue-check) */
function computeRentDueDates(assignment: {
  start_date: string;
  end_date: string | null;
  rate_term: string;
  rate_amount: number;
}): { dueDate: string; periodStart: string; periodEnd: string; amount: number; label: string }[] {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(assignment.start_date + 'T12:00:00');
  const endDate = assignment.end_date ? new Date(assignment.end_date + 'T12:00:00') : null;
  const dues: { dueDate: string; periodStart: string; periodEnd: string; amount: number; label: string }[] = [];

  if (assignment.rate_term === 'monthly') {
    let year = start.getFullYear();
    let month = start.getMonth();
    if (start.getDate() > 1) {
      month++;
      if (month > 11) { month = 0; year++; }
    }
    while (true) {
      const dueDate = new Date(year, month, 1, 12, 0, 0);
      if (dueDate > today) break;
      if (endDate && dueDate > endDate) break;
      const lastDay = new Date(year, month + 1, 0).getDate();
      const periodStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const periodEnd = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const label = dueDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      dues.push({ dueDate: periodStart, periodStart, periodEnd, amount: assignment.rate_amount, label });
      month++;
      if (month > 11) { month = 0; year++; }
    }
  } else if (assignment.rate_term === 'weekly' || assignment.rate_term === 'biweekly') {
    const intervalDays = assignment.rate_term === 'weekly' ? 7 : 14;
    const cursor = new Date(start);
    while (true) {
      const periodStart = cursor.toISOString().split('T')[0];
      const nextCursor = new Date(cursor);
      nextCursor.setDate(nextCursor.getDate() + intervalDays);
      const periodEnd = new Date(nextCursor);
      periodEnd.setDate(periodEnd.getDate() - 1);
      if (cursor > today) break;
      if (endDate && cursor > endDate) break;
      const ps = new Date(periodStart + 'T12:00:00');
      const pe = new Date(periodEnd.toISOString().split('T')[0] + 'T12:00:00');
      const label = `${ps.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${pe.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      dues.push({
        dueDate: periodStart,
        periodStart,
        periodEnd: periodEnd.toISOString().split('T')[0],
        amount: assignment.rate_amount,
        label,
      });
      cursor.setDate(cursor.getDate() + intervalDays);
    }
  }
  return dues;
}

/** Build and send confirmation email with payment summary */
async function sendPaymentConfirmation(
  supabase: ReturnType<typeof createClient>,
  row: { id: string; payment_type: string; amount: number; person_id: string | null; person_name: string | null },
): Promise<void> {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  if (!RESEND_API_KEY) {
    console.warn('No RESEND_API_KEY, skipping confirmation email');
    return;
  }

  // Look up the person
  if (!row.person_id) {
    console.log('No person_id on payment, skipping confirmation email');
    return;
  }

  const { data: person } = await supabase
    .from('people')
    .select('id, first_name, last_name, email')
    .eq('id', row.person_id)
    .single();

  if (!person?.email) {
    console.log('No email for person, skipping confirmation email');
    return;
  }

  // Find their active assignment
  const { data: assignments } = await supabase
    .from('assignments')
    .select('id, start_date, end_date, rate_term, rate_amount, monthly_rent, is_free, status')
    .eq('person_id', row.person_id)
    .eq('status', 'active');

  // Also find what space they're in
  let spaceName = 'YOUR_PROPERTY_NAME';
  if (assignments?.length) {
    const { data: aspaces } = await supabase
      .from('assignment_spaces')
      .select('space:space_id(name)')
      .eq('assignment_id', assignments[0].id);
    if (aspaces?.length) {
      const sp = aspaces[0].space as { name: string } | null;
      if (sp?.name) spaceName = sp.name;
    }
  }

  // Get all completed payments for this person from ledger
  const { data: allPayments } = await supabase
    .from('ledger')
    .select('id, category, amount, transaction_date, period_start, period_end, status, description')
    .eq('person_id', row.person_id)
    .eq('direction', 'income')
    .eq('status', 'completed')
    .eq('is_test', false)
    .order('transaction_date', { ascending: false });

  // Build payment history rows (most recent 10)
  const recentPayments = (allPayments || []).slice(0, 10);

  const categoryLabels: Record<string, string> = {
    rent: 'Rent',
    prorated_rent: 'Prorated Rent',
    security_deposit: 'Security Deposit',
    move_in_deposit: 'Move-in Deposit',
    application_fee: 'Application Fee',
    other: 'Payment',
  };

  // Build the "what's still owed" section
  let balanceDue = 0;
  let overdueRows: { label: string; amount: number; status: string }[] = [];

  if (assignments?.length) {
    const a = assignments[0];
    const effectiveRate = a.rate_amount || a.monthly_rent || 0;
    if (effectiveRate > 0 && !a.is_free && a.rate_term !== 'flat') {
      const dues = computeRentDueDates({
        start_date: a.start_date,
        end_date: a.end_date,
        rate_term: a.rate_term,
        rate_amount: effectiveRate,
      });

      for (const due of dues) {
        // Check if this period is paid
        const isPaid = (allPayments || []).some(p =>
          (p.category === 'rent' || p.category === 'prorated_rent') &&
          p.period_start && p.period_end &&
          p.period_start <= due.periodEnd && p.period_end >= due.periodStart
        );
        // Also check unlinked payments by date
        const hasUnlinked = !isPaid && (allPayments || []).some(p =>
          (p.category === 'rent' || p.category === 'prorated_rent') &&
          !p.period_start &&
          p.transaction_date >= due.periodStart && p.transaction_date <= due.periodEnd
        );

        if (!isPaid && !hasUnlinked) {
          balanceDue += due.amount;
          const dueD = new Date(due.dueDate + 'T12:00:00');
          const today = new Date();
          today.setHours(12, 0, 0, 0);
          const diffDays = Math.floor((today.getTime() - dueD.getTime()) / (1000 * 60 * 60 * 24));
          overdueRows.push({
            label: due.label,
            amount: due.amount,
            status: diffDays > 0 ? `${diffDays}d overdue` : 'Due today',
          });
        }
      }
    }
  }

  // Build the email HTML
  const paymentTypeLabel = categoryLabels[row.payment_type] || row.payment_type.replace(/_/g, ' ');

  const historyRowsHtml = recentPayments.slice(0, 5).map(p => {
    const cat = categoryLabels[p.category] || p.category.replace(/_/g, ' ');
    const desc = p.description || cat;
    return `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;color:#555;font-size:13px;">${formatDate(p.transaction_date)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;color:#333;font-size:13px;">${desc}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;text-align:right;color:#2e7d32;font-weight:600;font-size:13px;">${formatCurrency(p.amount)}</td>
    </tr>`;
  }).join('\n');

  const overdueHtml = overdueRows.length > 0
    ? `<div style="background:#fff3e0;border-left:4px solid #e65100;padding:16px 20px;margin:20px 0;border-radius:0 8px 8px 0;">
        <div style="font-size:13px;color:#e65100;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Outstanding Balance: ${formatCurrency(balanceDue)}</div>
        ${overdueRows.map(r => `
          <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;">
            <span style="color:#333;">${r.label}</span>
            <span>
              <strong>${formatCurrency(r.amount)}</strong>
              <span style="color:#e65100;margin-left:8px;font-size:11px;">${r.status}</span>
            </span>
          </div>
        `).join('')}
        <div style="text-align:center;margin-top:12px;">
          <a href="https://YOUR_DOMAIN/pay/?amount=${balanceDue}&person_id=${row.person_id}&person_name=${encodeURIComponent(person.first_name + ' ' + person.last_name)}&email=${encodeURIComponent(person.email)}&description=${encodeURIComponent('Remaining balance')}&payment_type=rent&reference_type=assignment${assignments?.length ? '&reference_id=' + assignments[0].id : ''}" style="display:inline-block;background:linear-gradient(135deg,#e65100 0%,#bf360c 100%);color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Pay ${formatCurrency(balanceDue)} Now</a>
        </div>
      </div>`
    : `<div style="background:#e8f5e9;border-left:4px solid #2e7d32;padding:16px 20px;margin:20px 0;border-radius:0 8px 8px 0;">
        <strong style="color:#2e7d32;font-size:15px;">&#10003; You're all caught up! No outstanding balance.</strong>
      </div>`;

  const emailHtml = `
    <div style="max-width:600px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.1);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="background:linear-gradient(135deg,#2e7d32 0%,#1b5e20 100%);padding:32px;text-align:center;">
        <div style="width:56px;height:56px;background:rgba(255,255,255,0.2);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;">
          <span style="font-size:28px;color:white;">&#10003;</span>
        </div>
        <h1 style="color:white;margin:0;font-size:22px;">Payment Received</h1>
        <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px;">YOUR_PROPERTY_NAME</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#333;font-size:16px;">Hi ${person.first_name},</p>
        <p style="color:#555;font-size:15px;">We've received your payment. Here's your receipt:</p>

        <div style="background:#f8f9fa;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
          <div style="font-size:13px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Amount Paid</div>
          <div style="font-size:32px;font-weight:700;color:#2e7d32;margin:4px 0;">${formatCurrency(row.amount)}</div>
          <div style="font-size:14px;color:#555;">${paymentTypeLabel} &bull; ${spaceName}</div>
          <div style="font-size:13px;color:#888;margin-top:4px;">via Stripe (card/bank) &bull; ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
        </div>

        ${overdueHtml}

        ${recentPayments.length > 0 ? `
        <div style="margin:24px 0;">
          <p style="font-weight:600;color:#333;font-size:14px;margin-bottom:8px;">Recent Payments</p>
          <table style="border-collapse:collapse;width:100%;font-size:14px;">
            <thead>
              <tr>
                <th style="padding:8px;text-align:left;border-bottom:2px solid #e0e0e0;color:#888;font-size:11px;text-transform:uppercase;">Date</th>
                <th style="padding:8px;text-align:left;border-bottom:2px solid #e0e0e0;color:#888;font-size:11px;text-transform:uppercase;">Description</th>
                <th style="padding:8px;text-align:right;border-bottom:2px solid #e0e0e0;color:#888;font-size:11px;text-transform:uppercase;">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${historyRowsHtml}
            </tbody>
          </table>
        </div>
        ` : ''}

        <p style="color:#555;font-size:14px;">If you have any questions, just reply to this email.</p>
        <p style="color:#555;font-size:14px;">Best regards,<br><strong>YOUR_PROPERTY_NAME</strong></p>
      </div>
      <div style="background:#f5f5f5;padding:16px 32px;text-align:center;border-top:1px solid #e0e0e0;">
        <p style="margin:0;color:#999;font-size:12px;">123 Main Stive, Your City, TX 00000</p>
      </div>
    </div>
  `;

  const emailText = `Payment Received

Hi ${person.first_name},

We've received your payment of ${formatCurrency(row.amount)} for ${paymentTypeLabel} (${spaceName}).

${balanceDue > 0 ? `Outstanding balance: ${formatCurrency(balanceDue)}\nPay now: https://YOUR_DOMAIN/pay/?amount=${balanceDue}&person_id=${row.person_id}` : 'You\'re all caught up! No outstanding balance.'}

Thank you!
YOUR_PROPERTY_NAME`;

  // Send to the payer
  try {
    const payerRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Property Team <team@YOUR_DOMAIN>',
        to: [person.email],
        reply_to: 'team@YOUR_DOMAIN',
        subject: `Payment Received - ${formatCurrency(row.amount)} - YOUR_PROPERTY_NAME`,
        html: emailHtml,
        text: emailText,
      }),
    });
    if (payerRes.ok) {
      console.log(`Confirmation email sent to ${person.email}`);
    } else {
      const err = await payerRes.json();
      console.error('Failed to send confirmation email to payer:', err);
    }
  } catch (err) {
    console.error('Error sending confirmation email to payer:', err);
  }

  // Forward to payments@ for record-keeping
  try {
    const adminRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Property System <auto@YOUR_DOMAIN>',
        to: [PAYMENTS_EMAIL],
        subject: `[Stripe] ${formatCurrency(row.amount)} received from ${person.first_name} ${person.last_name} - ${paymentTypeLabel}`,
        html: emailHtml,
        text: emailText,
      }),
    });
    if (adminRes.ok) {
      console.log(`Payment notification forwarded to ${PAYMENTS_EMAIL}`);
    } else {
      const err = await adminRes.json();
      console.error('Failed to forward to payments@:', err);
    }
  } catch (err) {
    console.error('Error forwarding to payments@:', err);
  }

  // Log API usage (2 emails sent)
  await supabase.from('api_usage_log').insert({
    vendor: 'resend',
    category: 'email_payment_confirmation',
    endpoint: 'emails',
    units: 2,
    unit_type: 'emails',
    estimated_cost_usd: 2 * 0.00028,
    metadata: { person_id: row.person_id, amount: row.amount, payment_type: row.payment_type },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const rawBody = await req.text();
  const signature = req.headers.get('Stripe-Signature');

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: config, error: configError } = await supabase
      .from('stripe_config')
      .select('webhook_secret, sandbox_webhook_secret, test_mode')
      .single();

    if (configError || !config) {
      console.error('Stripe config not found:', configError);
      return new Response(JSON.stringify({ error: 'Stripe config not found' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const webhookSecret = config.test_mode ? config.sandbox_webhook_secret : config.webhook_secret;
    if (!webhookSecret) {
      console.warn('No webhook secret configured');
      return new Response(JSON.stringify({ received: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const valid = await verifyStripeWebhook(rawBody, signature, webhookSecret);
    if (!valid) {
      console.error('Stripe webhook signature verification failed');
      return new Response(
        JSON.stringify({ error: 'Webhook signature verification failed' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const event = JSON.parse(rawBody) as StripeEvent;
    console.log('Stripe webhook:', event.type, event.id);

    switch (event.type) {
      case 'transfer.paid': {
        const transfer = event.data.object as { id: string };
        const newStatus = 'completed';
        const { data: payouts } = await supabase
          .from('payouts')
          .select('id, ledger_id')
          .eq('external_payout_id', transfer.id)
          .eq('payment_method', 'stripe');

        if (payouts?.length) {
          for (const p of payouts) {
            await supabase.from('payouts').update({
              status: newStatus,
              updated_at: new Date().toISOString()
            }).eq('id', p.id);
            if (p.ledger_id) {
              await supabase.from('ledger').update({
                status: 'completed',
                updated_at: new Date().toISOString()
              }).eq('id', p.ledger_id);
            }
          }
        }
        break;
      }

      case 'transfer.failed':
      case 'transfer.reversed': {
        const transfer = event.data.object as { id: string; failure_message?: string };
        const newStatus = event.type === 'transfer.reversed' ? 'returned' : 'failed';
        const { data: payouts } = await supabase
          .from('payouts')
          .select('id, ledger_id')
          .eq('external_payout_id', transfer.id)
          .eq('payment_method', 'stripe');

        if (payouts?.length) {
          for (const p of payouts) {
            await supabase.from('payouts').update({
              status: newStatus,
              updated_at: new Date().toISOString(),
              error_message: transfer.failure_message || event.type
            }).eq('id', p.id);
            if (p.ledger_id) {
              await supabase.from('ledger').update({
                status: 'failed',
                updated_at: new Date().toISOString()
              }).eq('id', p.ledger_id);
            }
          }
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object as { id: string };
        const { data: rows } = await supabase
          .from('stripe_payments')
          .select('id, ledger_id, payment_type, amount, original_amount, fee_amount, person_id, person_name')
          .eq('stripe_payment_intent_id', pi.id);

        const PAYMENT_TYPE_TO_CATEGORY: Record<string, string> = {
          rental_application: 'application_fee',
          rent: 'rent',
          prorated_rent: 'prorated_rent',
          security_deposit: 'security_deposit',
          move_in_deposit: 'move_in_deposit',
          reservation_deposit: 'reservation_deposit',
          event_rental_fee: 'event_rental_fee',
          event_reservation_deposit: 'event_reservation_deposit',
          event_cleaning_deposit: 'event_cleaning_deposit',
          other: 'other'
        };

        if (rows?.length) {
          for (const row of rows) {
            const category = PAYMENT_TYPE_TO_CATEGORY[row.payment_type] || 'other';
            // Use original_amount (before fee) for the income entry; fall back to amount
            const incomeAmount = row.original_amount && row.original_amount > 0
              ? row.original_amount
              : row.amount;
            const feeAmount = row.fee_amount || 0;
            const today = new Date().toISOString().split('T')[0];

            const { data: ledgerEntry, error: ledgerErr } = await supabase
              .from('ledger')
              .insert({
                direction: 'income',
                category,
                amount: incomeAmount,
                payment_method: 'stripe',
                transaction_date: today,
                person_id: row.person_id || null,
                person_name: row.person_name || null,
                status: 'completed',
                description: `Stripe payment: ${row.payment_type.replace(/_/g, ' ')}`,
                recorded_by: 'system:stripe-webhook',
                is_test: false
              })
              .select('id')
              .single();

            // Record processing fee as expense if present
            if (feeAmount > 0) {
              await supabase.from('ledger').insert({
                direction: 'expense',
                category: 'processing_fee',
                amount: feeAmount,
                payment_method: 'stripe',
                transaction_date: today,
                person_id: row.person_id || null,
                person_name: row.person_name || null,
                status: 'completed',
                description: `Stripe processing fee (${row.payment_type.replace(/_/g, ' ')})`,
                recorded_by: 'system:stripe-webhook',
                is_test: false
              });
            }

            if (!ledgerErr && ledgerEntry) {
              await supabase.from('stripe_payments').update({
                status: 'completed',
                ledger_id: ledgerEntry.id,
                updated_at: new Date().toISOString()
              }).eq('id', row.id);
            } else {
              await supabase.from('stripe_payments').update({
                status: 'completed',
                updated_at: new Date().toISOString()
              }).eq('id', row.id);
            }

            // Send confirmation email with statement summary
            try {
              await sendPaymentConfirmation(supabase, row);
            } catch (emailErr) {
              console.error('Error in sendPaymentConfirmation:', emailErr);
              // Don't fail the webhook response because of email errors
            }
          }
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as { id: string; last_payment_error?: { message?: string } };
        const { data: rows } = await supabase
          .from('stripe_payments')
          .select('id, ledger_id')
          .eq('stripe_payment_intent_id', pi.id);

        if (rows?.length) {
          for (const row of rows) {
            await supabase.from('stripe_payments').update({
              status: 'failed',
              error_message: pi.last_payment_error?.message || 'Payment failed',
              updated_at: new Date().toISOString()
            }).eq('id', row.id);
            if (row.ledger_id) {
              await supabase.from('ledger').update({
                status: 'failed',
                updated_at: new Date().toISOString()
              }).eq('id', row.ledger_id);
            }
          }
        }
        break;
      }

      case 'account.updated': {
        // Stripe Connect onboarding status update
        const account = event.data.object as {
          id: string;
          charges_enabled?: boolean;
          payouts_enabled?: boolean;
          details_submitted?: boolean;
        };
        console.log('Connect account updated:', account.id, {
          charges_enabled: account.charges_enabled,
          payouts_enabled: account.payouts_enabled,
          details_submitted: account.details_submitted,
        });

        // Find the associate with this Connect account
        const { data: assocProfiles } = await supabase
          .from('associate_profiles')
          .select('id, app_user_id')
          .eq('stripe_connect_account_id', account.id);

        if (assocProfiles?.length) {
          const updateData: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
          };

          // If payouts are now enabled, the onboarding is complete
          if (account.payouts_enabled) {
            console.log(`Connect account ${account.id} is now payouts-enabled`);
            updateData.payment_method = 'stripe';
          }

          await supabase
            .from('associate_profiles')
            .update(updateData)
            .eq('stripe_connect_account_id', account.id);
        }
        break;
      }

      default:
        console.log('Unhandled Stripe event type:', event.type);
    }

    return new Response(
      JSON.stringify({ received: true, type: event.type }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Stripe webhook error:', error);
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
