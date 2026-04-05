/**
 * Payment & Contract Overdue Check
 * Detects overdue rent, event payments, AND unsigned rental contracts.
 * Sends escalating reminders to the payer + CC team@YOUR_DOMAIN.
 *
 * Escalation: day 1 (friendly), day 3 (firm), day 5 (persistent), day 7+ (urgent)
 *
 * Trigger: Daily via pg_cron at 10 AM CT (3 PM UTC)
 * Deploy: supabase functions deploy payment-overdue-check
 * Manual: curl -X POST YOUR_SUPABASE_URL/functions/v1/payment-overdue-check -H "Authorization: Bearer <anon_key>"
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TEAM_EMAIL = 'team@YOUR_DOMAIN';
const ESCALATION_DAYS = [1, 3, 5, 7]; // days after due date
const PAY_BASE_URL = 'https://YOUR_DOMAIN/pay/';

interface OverdueItem {
  sourceType: string;
  sourceId: string;
  personId: string;
  personEmail: string;
  personFirstName: string;
  personLastName: string;
  periodLabel: string;
  amountDue: number;
  dueDate: string; // YYYY-MM-DD
  daysOverdue: number;
  rateTerm?: string;
  spaceName?: string;
  signwellDocumentId?: string;
}

function getEscalationLevel(daysOverdue: number): number | null {
  if (daysOverdue >= 7) return 4;
  if (daysOverdue >= 5) return 3;
  if (daysOverdue >= 3) return 2;
  if (daysOverdue >= 1) return 1;
  return null;
}

function getEscalationLabel(level: number | null): string {
  if (level === 1) return 'Friendly';
  if (level === 2) return 'Firm';
  if (level === 3) return 'Persistent';
  return 'Urgent';
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2).replace(/\.00$/, '')}`;
}

/** Infer which rent period a payment date falls into based on assignment schedule */
function inferPeriodFromDate(
  txDate: string,
  assignment: { start_date: string; end_date: string | null; rate_term: string }
): { start: string; end: string } | null {
  const pd = new Date(txDate + 'T12:00:00');
  const start = new Date(assignment.start_date + 'T12:00:00');
  if (pd < start) return null;

  if (assignment.rate_term === 'monthly') {
    const year = pd.getFullYear();
    const month = pd.getMonth();
    const lastDay = new Date(year, month + 1, 0).getDate();
    return {
      start: `${year}-${String(month + 1).padStart(2, '0')}-01`,
      end: `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  }

  if (assignment.rate_term === 'weekly' || assignment.rate_term === 'biweekly') {
    const intervalDays = assignment.rate_term === 'weekly' ? 7 : 14;
    const cursor = new Date(start);
    while (cursor <= pd) {
      const next = new Date(cursor);
      next.setDate(next.getDate() + intervalDays);
      if (pd < next) {
        const endD = new Date(next);
        endD.setDate(endD.getDate() - 1);
        return {
          start: cursor.toISOString().split('T')[0],
          end: endD.toISOString().split('T')[0],
        };
      }
      cursor.setDate(cursor.getDate() + intervalDays);
    }
  }

  return null;
}

/** Compute current rent due dates for an assignment */
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
      let effectiveLastDay = lastDay;
      let amount = assignment.rate_amount;
      // Prorate final partial month if lease ends mid-month
      if (endDate) {
        const endD = new Date(endDate);
        if (endD.getFullYear() === year && endD.getMonth() === month && endD.getDate() < lastDay) {
          effectiveLastDay = endD.getDate();
          amount = Math.round(assignment.rate_amount * effectiveLastDay / lastDay * 100) / 100;
        }
      }
      const periodEnd = `${year}-${String(month + 1).padStart(2, '0')}-${String(effectiveLastDay).padStart(2, '0')}`;
      const label = dueDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      dues.push({ dueDate: periodStart, periodStart, periodEnd, amount, label });
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
      let amount = assignment.rate_amount;
      // Prorate final partial period if lease ends mid-period
      if (endDate && periodEnd > endDate) {
        const fullDays = intervalDays;
        const actualDays = Math.ceil((endDate.getTime() - cursor.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        amount = Math.round(assignment.rate_amount * actualDays / fullDays * 100) / 100;
        periodEnd.setTime(endDate.getTime());
      }
      const ps = new Date(periodStart + 'T12:00:00');
      const pe = new Date(periodEnd.toISOString().split('T')[0] + 'T12:00:00');
      const label = `${ps.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${pe.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      dues.push({
        dueDate: periodStart,
        periodStart,
        periodEnd: periodEnd.toISOString().split('T')[0],
        amount,
        label,
      });
      cursor.setDate(cursor.getDate() + intervalDays);
    }
  }
  return dues;
}

/** Build the "Pay Now" URL with all params */
function buildPayUrl(opts: {
  amount: number;
  personId: string;
  personName: string;
  email: string;
  description: string;
  paymentType: string;
  referenceType: string;
  referenceId: string;
}): string {
  const p = new URLSearchParams();
  p.set('amount', String(opts.amount));
  p.set('person_id', opts.personId);
  p.set('person_name', opts.personName);
  p.set('email', opts.email);
  p.set('description', opts.description);
  p.set('payment_type', opts.paymentType);
  p.set('reference_type', opts.referenceType);
  p.set('reference_id', opts.referenceId);
  return `${PAY_BASE_URL}?${p.toString()}`;
}

/** Build branded payment method cards HTML for emails */
function buildPaymentMethodCardsHtml(
  methods: { name: string; method_type: string; account_identifier: string | null; instructions: string | null }[],
  memoText: string,
): string {
  const METHOD_STYLES: Record<string, { bg: string; border: string }> = {
    venmo: { bg: '#f0f7fc', border: '#3d95ce' },
    zelle: { bg: '#f3edfc', border: '#6c1cd3' },
    cashapp: { bg: '#e6fbe9', border: '#00D632' },
    paypal: { bg: '#eef1f8', border: '#003087' },
    bank_ach: { bg: '#f5f5f5', border: '#333333' },
    cash: { bg: '#f0f7f0', border: '#2e7d32' },
    check: { bg: '#f5f5f5', border: '#555555' },
  };

  return methods.map(m => {
    const style = METHOD_STYLES[m.method_type] || { bg: '#f5f5f5', border: '#888' };
    const id = m.account_identifier || '';
    const instr = (m.instructions || '').split('\n').filter(Boolean);
    // Build detail line
    let detail = '';
    if (id) detail += `<strong>${id}</strong>`;
    if (instr.length > 0) {
      const instrText = instr[0].replace(/"/g, '&quot;');
      if (detail) detail += ` &middot; `;
      detail += instrText;
    }
    if (memoText) {
      if (detail) detail += ` &middot; `;
      detail += `Include "${memoText}" in memo`;
    }

    return `<div style="background:${style.bg};border:2px solid ${style.border};border-radius:10px;padding:14px 18px;margin-bottom:8px;text-align:center;">
      <div style="font-weight:700;font-size:15px;color:#333;margin-bottom:2px;">${m.name}${id ? ` &mdash; ${id}` : ''}</div>
      ${detail ? `<div style="font-size:13px;color:#666;">${detail.replace(id ? `<strong>${id}</strong> &middot; ` : '', '')}</div>` : ''}
    </div>`;
  }).join('\n');
}

/** Build contract signing reminder email */
function buildContractReminderEmail(
  item: OverdueItem,
  level: number,
): { subject: string; html: string; text: string } {
  const spaceName = item.spaceName || 'your space';
  const daysSince = item.daysOverdue;

  let headerBg: string;
  let headerSubtext: string;
  let subject: string;
  let introText: string;

  if (level === 1) {
    headerBg = '#1c1618';
    headerSubtext = 'Lease Signing Reminder';
    subject = `Reminder: Please sign your lease agreement - YOUR_PROPERTY_NAME`;
    introText = `Just a friendly reminder that your lease agreement for <strong>${spaceName}</strong> is ready for your signature. It was sent on ${formatDate(item.dueDate)}.`;
  } else if (level === 2) {
    headerBg = '#1c1618';
    headerSubtext = 'Lease Signing Follow-Up';
    subject = `Follow-Up: Lease agreement awaiting signature - YOUR_PROPERTY_NAME`;
    introText = `This is a follow-up &mdash; your lease agreement for <strong>${spaceName}</strong> is still awaiting your signature. It was sent ${daysSince} days ago.`;
  } else if (level === 3) {
    headerBg = '#1c1618';
    headerSubtext = 'Lease Signing - Action Needed';
    subject = `Action Needed: Lease for ${spaceName} awaiting signature - YOUR_PROPERTY_NAME`;
    introText = `We haven't received your signature on the lease for <strong>${spaceName}</strong> yet. It's been ${daysSince} days since we sent it. Please sign soon to secure your space.`;
  } else {
    headerBg = '#1c1618';
    headerSubtext = 'Urgent: Lease Awaiting Signature';
    subject = `URGENT: Lease for ${spaceName} unsigned after ${daysSince} days - YOUR_PROPERTY_NAME`;
    introText = `Your lease for <strong>${spaceName}</strong> has been awaiting your signature for <strong>${daysSince} days</strong>. Please sign immediately or contact us if you have questions.`;
  }

  const statusColor = daysSince >= 7 ? '#c62828' : daysSince >= 5 ? '#e65100' : daysSince >= 3 ? '#d4883a' : '#2a1f23';

  const html = `
    <div style="max-width:600px;margin:0 auto;background:#faf9f6;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="background:${headerBg};padding:28px 32px;text-align:center;">
        <h1 style="color:#faf9f6;margin:0;font-size:22px;font-weight:600;">YOUR_PROPERTY_NAME</h1>
        <p style="color:rgba(250,249,246,0.65);margin:6px 0 0;font-size:14px;">${headerSubtext}</p>
      </div>
      <div style="padding:28px 32px;">
        <p style="color:#2a1f23;font-size:15px;margin-bottom:4px;">Hi ${item.personFirstName},</p>
        <p style="color:#7d6f74;font-size:14px;line-height:1.5;margin-bottom:20px;">${introText}</p>

        <div style="background:#f2f0e8;border-radius:8px;padding:20px;margin-bottom:24px;">
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:6px 0;color:#7d6f74;font-size:13px;">Space</td>
              <td style="padding:6px 0;color:#2a1f23;font-weight:600;text-align:right;">${spaceName}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#7d6f74;font-size:13px;">Sent On</td>
              <td style="padding:6px 0;color:#2a1f23;text-align:right;">${formatDate(item.dueDate)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#7d6f74;font-size:13px;">Days Waiting</td>
              <td style="padding:6px 0;color:${statusColor};font-weight:600;text-align:right;">${daysSince} days</td>
            </tr>
          </table>
        </div>

        <div style="text-align:center;margin-bottom:24px;">
          <p style="color:#7d6f74;font-size:14px;margin-bottom:12px;">Please check your email for the signing link from SignWell, or look for the original email titled "Signature Requested".</p>
        </div>

        <p style="color:#7d6f74;font-size:13px;margin-top:20px;line-height:1.5;">If you've already signed, please disregard this notice &mdash; it may take a moment to process. If you have questions about the lease terms, reply to this email.</p>
        <p style="color:#2a1f23;font-size:14px;margin-top:8px;">Best regards,<br><strong>YOUR_PROPERTY_NAME</strong></p>
      </div>
      <div style="background:#f2f0e8;padding:16px 32px;text-align:center;border-top:1px solid #e6e2d9;">
        <p style="margin:0;color:#7d6f74;font-size:12px;">123 Main Stive, Your City, TX 00000</p>
      </div>
    </div>
  `;

  const text = `${headerSubtext}

Hi ${item.personFirstName},

${introText.replace(/<[^>]*>/g, '').replace(/&mdash;/g, '—')}

Space: ${spaceName}
Sent On: ${formatDate(item.dueDate)}
Days Waiting: ${daysSince} days

Please check your email for the signing link from SignWell, or look for the original email titled "Signature Requested".

If you've already signed, please disregard this notice. If you have questions about the lease terms, reply to this email.

Best regards,
YOUR_PROPERTY_NAME`;

  return { subject, html, text };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

    if (!RESEND_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'RESEND_API_KEY not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    console.log(`Payment & contract overdue check running for ${todayStr}`);

    // ========== 0. Auto-complete ended assignments ==========
    const { data: staleActive, error: staleErr } = await supabase
      .from('assignments')
      .select('id, end_date, person:person_id (first_name, last_name)')
      .eq('status', 'active')
      .not('end_date', 'is', null)
      .lt('end_date', todayStr);

    if (staleActive && staleActive.length > 0) {
      for (const sa of staleActive) {
        const person = sa.person as { first_name: string; last_name: string } | null;
        const name = person ? `${person.first_name} ${person.last_name}` : 'unknown';
        console.log(`Auto-completing ended assignment ${sa.id} (${name}, ended ${sa.end_date})`);
        await supabase.from('assignments').update({ status: 'completed' }).eq('id', sa.id);
      }
      console.log(`Auto-completed ${staleActive.length} ended assignment(s)`);
    }

    // ========== A. Detect overdue rent ==========
    const { data: activeAssignments, error: assignError } = await supabase
      .from('assignments')
      .select(`
        id, status, start_date, end_date, rate_amount, rate_term, is_free, monthly_rent,
        person:person_id (id, first_name, last_name, email)
      `)
      .eq('status', 'active')
      .eq('is_free', false);

    if (assignError) {
      console.error('Error querying assignments:', assignError);
      throw assignError;
    }

    // Get space names for assignments
    const assignmentSpaceNames = new Map<string, string>();
    if (activeAssignments?.length) {
      const assignIds = activeAssignments.map(a => a.id);
      const { data: aspaces } = await supabase
        .from('assignment_spaces')
        .select('assignment_id, space:space_id(name)')
        .in('assignment_id', assignIds);
      for (const as of (aspaces || [])) {
        const sp = as.space as { name: string } | null;
        if (sp?.name) assignmentSpaceNames.set(as.assignment_id, sp.name);
      }
    }

    const overdueItems: OverdueItem[] = [];

    for (const assignment of (activeAssignments || [])) {
      const person = assignment.person as { id: string; first_name: string; last_name: string; email: string } | null;
      if (!person?.email) continue;
      if (!assignment.start_date) continue;
      if (assignment.rate_term === 'flat') continue;

      const effectiveRate = assignment.rate_amount || assignment.monthly_rent || 0;
      if (effectiveRate <= 0) continue;

      const dueDates = computeRentDueDates({
        start_date: assignment.start_date,
        end_date: assignment.end_date,
        rate_term: assignment.rate_term,
        rate_amount: effectiveRate,
      });

      // Check if a refund/credit has been issued for this assignment (account settled)
      const { data: refunds } = await supabase
        .from('ledger')
        .select('id')
        .eq('category', 'refund')
        .eq('status', 'completed')
        .eq('is_test', false)
        .or(`assignment_id.eq.${assignment.id},person_id.eq.${person.id}`)
        .limit(1);

      const hasRefund = refunds && refunds.length > 0;
      if (hasRefund) {
        console.log(`Skipping overdue check for ${person.email}: refund found on assignment ${assignment.id}`);
        continue;
      }

      // For each due date, check if paid
      for (const due of dueDates) {
        const dueD = new Date(due.dueDate + 'T12:00:00');
        const diffMs = today.getTime() - dueD.getTime();
        const daysOverdue = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        if (daysOverdue < 1) continue;
        if (daysOverdue > 30) continue;

        // Check ledger for a matching completed payment
        const { data: payments } = await supabase
          .from('ledger')
          .select('id, amount, period_start, period_end')
          .in('category', ['rent', 'prorated_rent'])
          .eq('status', 'completed')
          .eq('is_test', false)
          .or(`assignment_id.eq.${assignment.id},person_id.eq.${person.id}`)
          .gte('period_end', due.periodStart)
          .lte('period_start', due.periodEnd);

        // Also check unlinked payments (no period_start). For these, infer which
        // rent period they cover based on the assignment schedule, not just the
        // transaction_date falling within the due period window.
        const { data: unlinkedPayments } = await supabase
          .from('ledger')
          .select('id, amount, transaction_date')
          .in('category', ['rent', 'prorated_rent'])
          .eq('status', 'completed')
          .eq('is_test', false)
          .eq('person_id', person.id)
          .is('period_start', null);

        // Filter unlinked payments: infer their period from transaction_date + assignment schedule
        const matchedUnlinked = (unlinkedPayments || []).filter((p: { transaction_date: string }) => {
          const inferredPeriod = inferPeriodFromDate(p.transaction_date, assignment);
          if (!inferredPeriod) return false;
          // Check if inferred period overlaps the due period
          return inferredPeriod.start <= due.periodEnd && inferredPeriod.end >= due.periodStart;
        });

        // Sum all payments found for this period (partial or full)
        let totalPaid = 0;
        if (payments && payments.length > 0) {
          totalPaid += payments.reduce((sum: number, p: { amount: number }) => sum + (p.amount || 0), 0);
        }
        if (matchedUnlinked.length > 0) {
          totalPaid += matchedUnlinked.reduce((sum: number, p: { amount: number }) => sum + (p.amount || 0), 0);
        }

        const netRemaining = Math.round((due.amount - totalPaid) * 100) / 100;

        if (netRemaining > 0) {
          overdueItems.push({
            sourceType: 'rent',
            sourceId: assignment.id,
            personId: person.id,
            personEmail: person.email,
            personFirstName: person.first_name,
            personLastName: person.last_name,
            periodLabel: due.label,
            amountDue: netRemaining,
            dueDate: due.dueDate,
            daysOverdue,
            rateTerm: assignment.rate_term,
          });
        }
      }
    }

    // ========== B. Detect overdue event fees ==========
    const { data: events, error: eventsError } = await supabase
      .from('event_hosting_requests')
      .select(`
        id, event_name, event_date,
        rental_fee, cleaning_deposit, reservation_fee,
        rental_fee_paid, cleaning_deposit_paid, reservation_fee_paid,
        request_status,
        person:person_id (id, first_name, last_name, email)
      `)
      .eq('request_status', 'approved')
      .or('is_archived.is.null,is_archived.eq.false')
      .gte('event_date', todayStr);

    if (eventsError) {
      console.error('Error querying events:', eventsError);
      throw eventsError;
    }

    for (const event of (events || [])) {
      const person = event.person as { id: string; first_name: string; last_name: string; email: string } | null;
      if (!person?.email) continue;

      const eventDate = new Date(event.event_date + 'T12:00:00');
      const feeDueDate = new Date(eventDate);
      feeDueDate.setDate(feeDueDate.getDate() - 7);
      const feeDueDateStr = feeDueDate.toISOString().split('T')[0];

      if (today < feeDueDate) continue;

      const daysOverdue = Math.floor((today.getTime() - feeDueDate.getTime()) / (1000 * 60 * 60 * 24));
      if (daysOverdue < 1) continue;

      const feeTypes = [
        { type: 'event_rental_fee', paid: event.rental_fee_paid, amount: event.rental_fee || 295, label: 'Rental Fee' },
        { type: 'event_cleaning_deposit', paid: event.cleaning_deposit_paid, amount: event.cleaning_deposit || 195, label: 'Cleaning Deposit' },
        { type: 'event_reservation_fee', paid: event.reservation_fee_paid, amount: event.reservation_fee || 95, label: 'Reservation Fee' },
      ];

      for (const fee of feeTypes) {
        if (fee.paid) continue;
        overdueItems.push({
          sourceType: fee.type,
          sourceId: event.id,
          personId: person.id,
          personEmail: person.email,
          personFirstName: person.first_name,
          personLastName: person.last_name,
          periodLabel: `${event.event_name} - ${fee.label}`,
          amountDue: fee.amount,
          dueDate: feeDueDateStr,
          daysOverdue,
        });
      }
    }

    // ========== C. Detect unsigned rental contracts ==========
    const { data: unsignedContracts, error: contractError } = await supabase
      .from('rental_applications')
      .select(`
        id, agreement_status, agreement_sent_at, signwell_document_id,
        approved_move_in, approved_lease_end,
        is_archived, is_test,
        approved_space:approved_space_id (id, name),
        person:person_id (id, first_name, last_name, email)
      `)
      .eq('agreement_status', 'sent')
      .or('is_archived.is.null,is_archived.eq.false')
      .or('is_test.is.null,is_test.eq.false');

    if (contractError) {
      console.error('Error querying unsigned contracts:', contractError);
      // Don't throw — continue with payment reminders even if contract query fails
    } else {
      for (const app of (unsignedContracts || [])) {
        const person = app.person as { id: string; first_name: string; last_name: string; email: string } | null;
        if (!person?.email) continue;
        if (!app.agreement_sent_at) continue;

        const sentDate = new Date(app.agreement_sent_at);
        sentDate.setHours(12, 0, 0, 0);
        const diffMs = today.getTime() - sentDate.getTime();
        const daysSinceSent = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (daysSinceSent < 1 || daysSinceSent > 30) continue;

        // Skip if the lease period has already ended — no point reminding about an expired lease
        if (app.approved_lease_end) {
          const leaseEnd = new Date(app.approved_lease_end + 'T23:59:59');
          if (leaseEnd < today) {
            console.log(`Skipping contract reminder for ${person.email}: lease ended ${app.approved_lease_end}`);
            continue;
          }
        }

        const space = app.approved_space as { id: string; name: string } | null;

        overdueItems.push({
          sourceType: 'contract_unsigned',
          sourceId: app.id,
          personId: person.id,
          personEmail: person.email,
          personFirstName: person.first_name,
          personLastName: person.last_name,
          periodLabel: `Lease Agreement - ${space?.name || 'your space'}`,
          amountDue: 0,
          dueDate: app.agreement_sent_at.split('T')[0],
          daysOverdue: daysSinceSent,
          spaceName: space?.name || 'your space',
          signwellDocumentId: app.signwell_document_id,
        });
      }
    }

    const paymentItems = overdueItems.filter(i => i.sourceType !== 'contract_unsigned');
    const contractItems = overdueItems.filter(i => i.sourceType === 'contract_unsigned');

    console.log(`Found ${paymentItems.length} overdue payment items, ${contractItems.length} unsigned contracts`);

    if (overdueItems.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No overdue payments or unsigned contracts found', date: todayStr }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ========== D. Load existing reminders for deduplication ==========
    const { data: existingReminders } = await supabase
      .from('payment_reminders')
      .select('source_type, source_id, due_date, escalation_level, recipient_type')
      .in('status', ['sent']);

    const reminderMap = new Map<string, number>();
    for (const r of (existingReminders || [])) {
      const key = `${r.source_type}:${r.source_id}:${r.due_date}:${r.recipient_type}`;
      const current = reminderMap.get(key) || 0;
      if (r.escalation_level > current) reminderMap.set(key, r.escalation_level);
    }

    // Get payment methods for email
    const { data: paymentMethods } = await supabase
      .from('payment_methods')
      .select('name, method_type, account_identifier, instructions')
      .eq('is_active', true)
      .order('display_order');

    // Group overdue items by person, separated by type
    const personPaymentGroups = new Map<string, OverdueItem[]>();
    const personContractGroups = new Map<string, OverdueItem[]>();

    for (const item of overdueItems) {
      const level = getEscalationLevel(item.daysOverdue);
      if (!level) continue;

      const payerKey = `${item.sourceType}:${item.sourceId}:${item.dueDate}:payer`;
      const maxPayerLevel = reminderMap.get(payerKey) || 0;
      if (level <= maxPayerLevel) continue;

      if (item.sourceType === 'contract_unsigned') {
        if (!personContractGroups.has(item.personId)) {
          personContractGroups.set(item.personId, []);
        }
        personContractGroups.get(item.personId)!.push(item);
      } else {
        if (!personPaymentGroups.has(item.personId)) {
          personPaymentGroups.set(item.personId, []);
        }
        personPaymentGroups.get(item.personId)!.push(item);
      }
    }

    // ========== E. Send payment reminders ==========
    let remindersSent = 0;
    let errors = 0;
    const adminPaymentDigest: OverdueItem[] = [];
    const adminContractDigest: OverdueItem[] = [];

    // Pre-fetch ID verification status for persons with overdue payments
    const personIdVerification = new Map<string, { needsId: boolean; uploadUrl: string | null }>();
    for (const [personId] of personPaymentGroups) {
      try {
        const { data: apps } = await supabase
          .from('rental_applications')
          .select('identity_verification_status')
          .eq('person_id', personId)
          .order('created_at', { ascending: false })
          .limit(1);
        const latestApp = apps?.[0];
        const needsId = !latestApp || latestApp.identity_verification_status !== 'verified';
        let uploadUrl: string | null = null;
        if (needsId) {
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 7);
          const { data: tokenData } = await supabase
            .from('upload_tokens')
            .insert({
              person_id: personId,
              token_type: 'identity_verification',
              expires_at: expiresAt.toISOString(),
            })
            .select('token')
            .single();
          if (tokenData?.token) {
            uploadUrl = `https://YOUR_DOMAIN/spaces/verify.html?token=${tokenData.token}`;
          }
        }
        personIdVerification.set(personId, { needsId, uploadUrl });
      } catch (e) {
        console.warn(`Could not check ID verification for person ${personId}:`, e);
        personIdVerification.set(personId, { needsId: false, uploadUrl: null });
      }
    }

    // Send payment reminders (existing logic with CC team@)
    for (const [personId, items] of personPaymentGroups) {
      const first = items[0];
      const totalDue = items.reduce((sum, i) => sum + i.amountDue, 0);
      const maxDaysOverdue = Math.max(...items.map(i => i.daysOverdue));
      const level = getEscalationLevel(maxDaysOverdue)!;
      const periodsCount = items.length;

      const spaceName = assignmentSpaceNames.get(first.sourceId) || 'your space';
      const idInfo = personIdVerification.get(personId) || { needsId: false, uploadUrl: null };

      const periodRows = items.map(item => {
        const statusColor = item.daysOverdue >= 7 ? '#c62828' : item.daysOverdue >= 1 ? '#d4883a' : '#7d6f74';
        const statusText = item.daysOverdue > 0 ? `${item.daysOverdue} days overdue` : 'Due today';
        return `<tr>
          <td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;color:#333;font-size:14px;">${item.periodLabel}</td>
          <td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;text-align:center;color:#333;font-weight:600;font-size:14px;">${formatCurrency(item.amountDue)}</td>
          <td style="padding:12px 16px;border-bottom:1px solid #f0f0f0;text-align:right;"><span style="color:${statusColor};font-size:13px;font-weight:600;">${statusText}</span></td>
        </tr>`;
      }).join('\n');

      let headerBg: string;
      let headerSubtext: string;
      let subject: string;
      let introText: string;

      if (level === 1) {
        headerBg = '#1c1618';
        headerSubtext = 'Rent Payment Reminder';
        subject = `Rent Payment Due - ${formatCurrency(totalDue)} - ${first.personFirstName} - YOUR_PROPERTY_NAME`;
        introText = `This is a friendly reminder that you have <strong>${periodsCount} ${periodsCount === 1 ? 'week' : 'weeks'} of rent</strong> outstanding for the <strong>${spaceName}</strong>.`;
      } else if (level === 2) {
        headerBg = '#1c1618';
        headerSubtext = 'Rent Payment Follow-Up';
        subject = `Rent Payment Follow-Up - ${formatCurrency(totalDue)} - ${first.personFirstName} - YOUR_PROPERTY_NAME`;
        introText = `This is a follow-up regarding <strong>${periodsCount} ${periodsCount === 1 ? 'period' : 'periods'} of rent</strong> outstanding for the <strong>${spaceName}</strong>. Please submit payment at your earliest convenience.`;
      } else if (level === 3) {
        headerBg = '#1c1618';
        headerSubtext = 'Rent Payment - Action Needed';
        subject = `Action Needed: Rent Payment - ${formatCurrency(totalDue)} - ${first.personFirstName} - YOUR_PROPERTY_NAME`;
        introText = `You have <strong>${periodsCount} ${periodsCount === 1 ? 'period' : 'periods'} of rent</strong> outstanding for the <strong>${spaceName}</strong>. Please submit payment as soon as possible.`;
      } else {
        headerBg = '#1c1618';
        headerSubtext = 'Urgent: Rent Payment Overdue';
        subject = `URGENT: Rent Payment Overdue - ${formatCurrency(totalDue)} - ${first.personFirstName} - YOUR_PROPERTY_NAME`;
        introText = `You have <strong>${periodsCount} ${periodsCount === 1 ? 'period' : 'periods'} of overdue rent</strong> totaling <strong>${formatCurrency(totalDue)}</strong> for the <strong>${spaceName}</strong>. Please submit payment immediately to avoid additional fees.`;
      }

      const payUrl = buildPayUrl({
        amount: totalDue,
        personId: first.personId,
        personName: `${first.personFirstName} ${first.personLastName}`,
        email: first.personEmail,
        description: `${periodsCount === 1 ? items[0].periodLabel : periodsCount + ' periods'} rent`,
        paymentType: 'rent',
        referenceType: 'assignment',
        referenceId: first.sourceId,
      });

      const memoText = `${first.personFirstName} rent`;
      const methodCardsHtml = buildPaymentMethodCardsHtml(paymentMethods || [], memoText);

      const emailHtml = `
        <div style="max-width:600px;margin:0 auto;background:#faf9f6;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <div style="background:${headerBg};padding:28px 32px;text-align:center;">
            <h1 style="color:#faf9f6;margin:0;font-size:22px;font-weight:600;">YOUR_PROPERTY_NAME</h1>
            <p style="color:rgba(250,249,246,0.65);margin:6px 0 0;font-size:14px;">${headerSubtext}</p>
          </div>
          <div style="padding:28px 32px;">
            <p style="color:#2a1f23;font-size:15px;margin-bottom:4px;">Hi ${first.personFirstName},</p>
            <p style="color:#7d6f74;font-size:14px;line-height:1.5;margin-bottom:20px;">${introText}</p>

            <table style="border-collapse:collapse;width:100%;margin-bottom:4px;">
              <thead>
                <tr style="background:#f2f0e8;">
                  <th style="padding:10px 16px;text-align:left;font-size:12px;color:#7d6f74;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Period</th>
                  <th style="padding:10px 16px;text-align:center;font-size:12px;color:#7d6f74;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Amount</th>
                  <th style="padding:10px 16px;text-align:right;font-size:12px;color:#7d6f74;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Status</th>
                </tr>
              </thead>
              <tbody>
                ${periodRows}
              </tbody>
            </table>
            <div style="background:#f2f0e8;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;border-radius:0 0 8px 8px;margin-bottom:24px;">
              <span style="font-weight:600;color:#2a1f23;font-size:14px;">Total Due</span>
              <span style="font-weight:800;color:#2a1f23;font-size:20px;">${formatCurrency(totalDue)}</span>
            </div>

            ${(paymentMethods || []).length > 0 ? `
            <p style="color:#2a1f23;font-size:14px;font-weight:600;margin-bottom:12px;text-align:center;">Pay with no fees:</p>
            ${methodCardsHtml}
            ` : ''}

            <div style="text-align:center;color:#7d6f74;font-size:13px;margin:20px 0;border-top:1px solid #e6e2d9;padding-top:20px;">or pay online</div>
            <div style="text-align:center;margin-bottom:8px;">
              <a href="${payUrl}" style="display:inline-block;background:#d4883a;color:white;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:17px;font-weight:700;letter-spacing:0.3px;box-shadow:0 2px 8px rgba(212,136,58,0.30);">Pay ${formatCurrency(totalDue)} Online</a>
              <p style="color:#7d6f74;font-size:12px;margin-top:8px;">Credit card, debit card, or bank transfer (ACH) &mdash; 0.8% processing fee, max $5</p>
            </div>

            ${idInfo.needsId ? `
            <div style="margin:20px 0;padding:16px;background:#f2f0e8;border-left:4px solid #d4883a;border-radius:4px;">
              <p style="margin:0 0 8px;font-weight:bold;color:#2a1f23;">ID Verification Required</p>
              <p style="margin:0;color:#7d6f74;font-size:14px;">We also need a copy of your government-issued photo ID to complete your rental setup.</p>
              ${idInfo.uploadUrl
                ? `<p style="margin:12px 0 0;"><a href="${idInfo.uploadUrl}" style="display:inline-block;padding:10px 20px;background:#d4883a;color:#fff;text-decoration:none;border-radius:4px;font-weight:bold;">Upload Your ID</a></p>`
                : `<p style="margin:8px 0 0;color:#7d6f74;font-size:14px;">Please reply to this email with a photo of your ID.</p>`}
            </div>
            ` : ''}

            <p style="color:#7d6f74;font-size:13px;margin-top:20px;line-height:1.5;">If you've already sent payment, please disregard this notice &mdash; it may take a day to process.</p>
            <p style="color:#2a1f23;font-size:14px;margin-top:8px;">Best regards,<br><strong>YOUR_PROPERTY_NAME</strong></p>
          </div>
          <div style="background:#f2f0e8;padding:16px 32px;text-align:center;border-top:1px solid #e6e2d9;">
            <p style="margin:0;color:#7d6f74;font-size:12px;">123 Main Stive, Your City, TX 00000</p>
          </div>
        </div>
      `;

      const payMethodsText = (paymentMethods || []).map(pm => {
        let line = `- ${pm.name}`;
        if (pm.account_identifier) line += `: ${pm.account_identifier}`;
        if (pm.instructions) line += ` (${pm.instructions.split('\n')[0]})`;
        return line;
      }).join('\n');

      const emailText = `${headerSubtext}

Hi ${first.personFirstName},

You have ${periodsCount} ${periodsCount === 1 ? 'period' : 'periods'} of rent outstanding for the ${spaceName}.

${items.map(i => `  ${i.periodLabel}: ${formatCurrency(i.amountDue)} (${i.daysOverdue}d overdue)`).join('\n')}

Total Due: ${formatCurrency(totalDue)}

Pay with no fees:
${payMethodsText}

Please include "${memoText}" in the payment memo.

Or pay online (0.8% processing fee, max $5): ${payUrl}
${idInfo.needsId ? `
ID VERIFICATION REQUIRED
We also need a copy of your government-issued photo ID to complete your rental setup.
${idInfo.uploadUrl ? `Upload here: ${idInfo.uploadUrl}` : 'Please reply to this email with a photo of your ID.'}
` : ''}
If you've already sent payment, please disregard this notice.

Best regards,
YOUR_PROPERTY_NAME`;

      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Property Team <team@YOUR_DOMAIN>',
            to: [first.personEmail],
            cc: [TEAM_EMAIL],
            reply_to: 'team@YOUR_DOMAIN',
            subject,
            html: emailHtml,
            text: emailText,
          }),
        });

        if (emailRes.ok) {
          const resendData = await emailRes.json();
          for (const item of items) {
            await supabase.from('payment_reminders').insert({
              source_type: item.sourceType,
              source_id: item.sourceId,
              person_id: item.personId,
              period_label: item.periodLabel,
              amount_due: item.amountDue,
              due_date: item.dueDate,
              days_overdue: item.daysOverdue,
              channel: 'email',
              recipient: item.personEmail,
              recipient_type: 'payer',
              status: 'sent',
              escalation_level: level,
              metadata: { resend_id: resendData.id, grouped: true, total_due: totalDue },
            });
          }
          remindersSent += items.length;
          adminPaymentDigest.push(...items);
          console.log(`Sent L${level} payment reminder (${items.length} periods, ${formatCurrency(totalDue)}) to ${first.personEmail}`);
        } else {
          const errBody = await emailRes.json();
          console.error(`Failed to send payment reminder to ${first.personEmail}:`, errBody);
          for (const item of items) {
            await supabase.from('payment_reminders').insert({
              source_type: item.sourceType,
              source_id: item.sourceId,
              person_id: item.personId,
              period_label: item.periodLabel,
              amount_due: item.amountDue,
              due_date: item.dueDate,
              days_overdue: item.daysOverdue,
              channel: 'email',
              recipient: item.personEmail,
              recipient_type: 'payer',
              status: 'failed',
              escalation_level: level,
              error_message: JSON.stringify(errBody),
            });
          }
          errors++;
        }
      } catch (err) {
        console.error(`Error sending payment reminder to ${first.personEmail}:`, err);
        errors++;
      }
    }

    // ========== F. Send contract signing reminders ==========
    for (const [personId, items] of personContractGroups) {
      for (const item of items) {
        const level = getEscalationLevel(item.daysOverdue)!;
        const { subject, html, text } = buildContractReminderEmail(item, level);

        try {
          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'Property Team <team@YOUR_DOMAIN>',
              to: [item.personEmail],
              cc: [TEAM_EMAIL],
              reply_to: 'team@YOUR_DOMAIN',
              subject,
              html,
              text,
            }),
          });

          if (emailRes.ok) {
            const resendData = await emailRes.json();
            await supabase.from('payment_reminders').insert({
              source_type: 'contract_unsigned',
              source_id: item.sourceId,
              person_id: item.personId,
              period_label: item.periodLabel,
              amount_due: 0,
              due_date: item.dueDate,
              days_overdue: item.daysOverdue,
              channel: 'email',
              recipient: item.personEmail,
              recipient_type: 'payer',
              status: 'sent',
              escalation_level: level,
              metadata: { resend_id: resendData.id, signwell_document_id: item.signwellDocumentId },
            });
            remindersSent++;
            adminContractDigest.push(item);
            console.log(`Sent L${level} contract reminder (${item.spaceName}) to ${item.personEmail}`);
          } else {
            const errBody = await emailRes.json();
            console.error(`Failed to send contract reminder to ${item.personEmail}:`, errBody);
            await supabase.from('payment_reminders').insert({
              source_type: 'contract_unsigned',
              source_id: item.sourceId,
              person_id: item.personId,
              period_label: item.periodLabel,
              amount_due: 0,
              due_date: item.dueDate,
              days_overdue: item.daysOverdue,
              channel: 'email',
              recipient: item.personEmail,
              recipient_type: 'payer',
              status: 'failed',
              escalation_level: level,
              error_message: JSON.stringify(errBody),
            });
            errors++;
          }
        } catch (err) {
          console.error(`Error sending contract reminder to ${item.personEmail}:`, err);
          errors++;
        }
      }
    }

    // ========== G. Send admin digest ==========
    const allDigestItems = [...adminPaymentDigest, ...adminContractDigest];
    if (allDigestItems.length > 0) {
      try {
        // Payment section
        const paymentSummaries = new Map<string, { name: string; items: OverdueItem[]; total: number }>();
        for (const item of adminPaymentDigest) {
          const key = item.personId;
          if (!paymentSummaries.has(key)) {
            paymentSummaries.set(key, {
              name: `${item.personFirstName} ${item.personLastName}`,
              items: [],
              total: 0,
            });
          }
          const s = paymentSummaries.get(key)!;
          s.items.push(item);
          s.total += item.amountDue;
        }

        const totalOverdue = adminPaymentDigest.reduce((sum, i) => sum + i.amountDue, 0);

        const paymentRows = Array.from(paymentSummaries.values()).map(s => {
          const maxDays = Math.max(...s.items.map(i => i.daysOverdue));
          const level = getEscalationLevel(maxDays);
          return `<tr>
            <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${s.name}</td>
            <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${s.items.length} period${s.items.length > 1 ? 's' : ''}</td>
            <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${formatCurrency(s.total)}</td>
            <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${maxDays}d</td>
            <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${getEscalationLabel(level)}</td>
          </tr>`;
        }).join('\n');

        // Contract section
        const contractRows = adminContractDigest.map(item => {
          const level = getEscalationLevel(item.daysOverdue);
          return `<tr>
            <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${item.personFirstName} ${item.personLastName}</td>
            <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${item.spaceName || 'Unknown'}</td>
            <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${item.daysOverdue}d</td>
            <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${getEscalationLabel(level)}</td>
          </tr>`;
        }).join('\n');

        // Build subject
        const subjectParts: string[] = [];
        if (adminPaymentDigest.length > 0) {
          subjectParts.push(`Late Payments (${paymentSummaries.size})`);
        }
        if (adminContractDigest.length > 0) {
          subjectParts.push(`Unsigned Contracts (${adminContractDigest.length})`);
        }
        const digestSubject = `${subjectParts.join(' + ')} - YOUR_PROPERTY_NAME`;

        let digestHtml = `<h2>Overdue Report - ${formatDate(todayStr)}</h2>`;

        if (adminPaymentDigest.length > 0) {
          digestHtml += `
            <h3>Overdue Payments</h3>
            <p>${adminPaymentDigest.length} overdue period${adminPaymentDigest.length > 1 ? 's' : ''} across ${paymentSummaries.size} tenant${paymentSummaries.size > 1 ? 's' : ''} totaling <strong>${formatCurrency(totalOverdue)}</strong>. Reminders have been sent.</p>
            <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
              <thead>
                <tr style="background: #f0f0f0;">
                  <th style="padding: 8px 10px; text-align: left;">Tenant</th>
                  <th style="padding: 8px 10px; text-align: left;">Periods</th>
                  <th style="padding: 8px 10px; text-align: left;">Amount</th>
                  <th style="padding: 8px 10px; text-align: left;">Max Overdue</th>
                  <th style="padding: 8px 10px; text-align: left;">Level</th>
                </tr>
              </thead>
              <tbody>${paymentRows}</tbody>
            </table>
          `;
        }

        if (adminContractDigest.length > 0) {
          digestHtml += `
            <h3>Unsigned Contracts</h3>
            <p>${adminContractDigest.length} lease agreement${adminContractDigest.length > 1 ? 's' : ''} awaiting signature. Reminders have been sent.</p>
            <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
              <thead>
                <tr style="background: #f0f0f0;">
                  <th style="padding: 8px 10px; text-align: left;">Applicant</th>
                  <th style="padding: 8px 10px; text-align: left;">Space</th>
                  <th style="padding: 8px 10px; text-align: left;">Days Unsigned</th>
                  <th style="padding: 8px 10px; text-align: left;">Level</th>
                </tr>
              </thead>
              <tbody>${contractRows}</tbody>
            </table>
          `;
        }

        digestHtml += `<p style="color: #666; font-size: 0.9em;">This is an automated report from the payment & contract overdue checker.</p>`;

        // Plain text version
        let digestText = `Overdue Report - ${formatDate(todayStr)}\n\n`;
        if (adminPaymentDigest.length > 0) {
          digestText += `OVERDUE PAYMENTS\n${adminPaymentDigest.length} overdue payments totaling ${formatCurrency(totalOverdue)}.\n\n`;
          digestText += Array.from(paymentSummaries.values()).map(s => {
            const maxDays = Math.max(...s.items.map(i => i.daysOverdue));
            return `- ${s.name}: ${s.items.length} periods, ${formatCurrency(s.total)} (${maxDays}d overdue)`;
          }).join('\n');
          digestText += '\n\n';
        }
        if (adminContractDigest.length > 0) {
          digestText += `UNSIGNED CONTRACTS\n${adminContractDigest.length} lease agreements awaiting signature.\n\n`;
          digestText += adminContractDigest.map(i =>
            `- ${i.personFirstName} ${i.personLastName}: ${i.spaceName || 'Unknown'} (${i.daysOverdue}d unsigned)`
          ).join('\n');
          digestText += '\n\n';
        }
        digestText += 'Reminders have been sent.';

        const adminEmailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Property System <auto@YOUR_DOMAIN>',
            to: [TEAM_EMAIL],
            subject: digestSubject,
            html: digestHtml,
            text: digestText,
          }),
        });

        if (adminEmailRes.ok) {
          const resendData = await adminEmailRes.json();
          await supabase.from('payment_reminders').insert({
            source_type: 'admin_digest',
            source_id: null,
            person_id: null,
            period_label: `${allDigestItems.length} overdue items`,
            amount_due: totalOverdue,
            due_date: todayStr,
            days_overdue: 0,
            channel: 'email',
            recipient: TEAM_EMAIL,
            recipient_type: 'admin',
            status: 'sent',
            escalation_level: 0,
            metadata: {
              resend_id: resendData.id,
              payment_items: adminPaymentDigest.length,
              contract_items: adminContractDigest.length,
            },
          });
          console.log(`Admin digest sent to ${TEAM_EMAIL}`);
        } else {
          const errBody = await adminEmailRes.json();
          console.error('Failed to send admin digest:', errBody);
        }
      } catch (err) {
        console.error('Error sending admin digest:', err);
      }
    }

    // ========== H. Log API usage ==========
    const totalPersons = new Set([...personPaymentGroups.keys(), ...personContractGroups.keys()]).size;
    const emailsSent = totalPersons + (allDigestItems.length > 0 ? 1 : 0);
    if (emailsSent > 0) {
      await supabase.from('api_usage_log').insert({
        vendor: 'resend',
        category: 'email_payment_reminder',
        endpoint: 'emails',
        units: emailsSent,
        unit_type: 'emails',
        estimated_cost_usd: emailsSent * 0.00028,
        metadata: {
          overdue_items: overdueItems.length,
          payment_items: paymentItems.length,
          contract_items: contractItems.length,
          reminders_sent: remindersSent,
          persons: totalPersons,
        },
      });
    }

    const result = {
      success: true,
      date: todayStr,
      overduePayments: paymentItems.length,
      unsignedContracts: contractItems.length,
      personsNotified: totalPersons,
      remindersSent,
      errors,
      adminDigestSent: allDigestItems.length > 0,
    };

    console.log('Payment & contract overdue check complete:', result);

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Payment & contract overdue check error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
