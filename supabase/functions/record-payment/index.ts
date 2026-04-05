/**
 * Record Payment Edge Function
 *
 * Receives payment information from OpenClaw, matches to tenant using
 * cached mappings or Gemini AI, and records the payment.
 *
 * Deploy with: supabase functions deploy record-payment
 * Endpoint: YOUR_SUPABASE_URL/functions/v1/record-payment
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { parsePaymentString } from './payment-parser.ts';
import { matchTenant } from './tenant-matcher.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

interface PaymentRequest {
  name?: string;
  payment_string: string;
  source?: string;
  force_gemini?: boolean;
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
    const { name, payment_string, source = 'openclaw', force_gemini = false } = body;

    console.log('Received payment request:', { name, payment_string, source });

    if (!payment_string) {
      return new Response(
        JSON.stringify({ success: false, error: 'payment_string is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step 1: Parse the payment string
    const parsed = parsePaymentString(payment_string);
    console.log('Parsed payment:', parsed);

    // Use provided name or extracted sender name
    const senderName = name || parsed.sender_name;

    if (!senderName) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Could not determine sender name. Provide "name" parameter or include sender in payment_string.',
          parsed_payment: {
            amount: parsed.amount,
            date: parsed.date?.toISOString().split('T')[0],
            method: parsed.method
          }
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step 2: Match to tenant
    const matchResult = await matchTenant(supabase, senderName, parsed.amount, force_gemini);

    // Step 3: Log the processing attempt
    const { data: logEntry, error: logError } = await supabase
      .from('payment_processing_log')
      .insert({
        raw_payment_string: payment_string,
        sender_name: senderName,
        parsed_amount: parsed.amount,
        parsed_date: parsed.date?.toISOString().split('T')[0],
        parsed_method: parsed.method,
        matched_person_id: matchResult.person_id,
        matched_assignment_id: matchResult.assignment_id,
        match_method: matchResult.method,
        gemini_response: matchResult.raw_response,
        status: matchResult.matched ? 'success' : 'pending_review'
      })
      .select()
      .single();

    if (logError) {
      console.error('Error creating log entry:', logError);
    }

    // Step 4: If matched with high confidence, record the payment
    if (matchResult.matched && matchResult.assignment_id) {
      const paymentDate = parsed.date?.toISOString().split('T')[0] || new Date().toISOString().split('T')[0];

      // Map parsed method to valid payment_method_type enum values
      const methodMap: Record<string, string> = {
        'zelle': 'zelle',
        'venmo': 'venmo',
        'paypal': 'paypal',
        'check': 'check',
        'cash': 'cash',
        'stripe': 'stripe'
      };
      const paymentMethod = methodMap[parsed.method?.toLowerCase() || ''] || 'other';

      // Pre-infer category for payment type (basic keywords before full inference)
      const rawStr = payment_string.toLowerCase();
      const paymentType = (rawStr.includes('deposit') || rawStr.includes('security')) ? 'deposit' : 'rent';

      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .insert({
          assignment_id: matchResult.assignment_id,
          type: paymentType,
          amount_received: parsed.amount,
          received_date: paymentDate,
          payment_method: paymentMethod,
          sender_name: senderName,
          status: 'paid',
          notes: `Auto-recorded from ${source}. Match method: ${matchResult.method}${matchResult.reasoning ? `. ${matchResult.reasoning}` : ''}`
        })
        .select()
        .single();

      if (paymentError) {
        console.error('Error recording payment:', paymentError);

        // Update log with error
        if (logEntry) {
          await supabase
            .from('payment_processing_log')
            .update({ status: 'failed', error_message: paymentError.message })
            .eq('id', logEntry.id);
        }

        return new Response(
          JSON.stringify({
            success: false,
            error: `Failed to record payment: ${paymentError.message}`,
            matched_tenant: {
              id: matchResult.person_id,
              name: matchResult.person_name
            }
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Compute rent period and infer category from assignment schedule
      let periodStart: string | null = null;
      let periodEnd: string | null = null;
      const { data: assignmentData } = await supabase
        .from('assignments')
        .select('start_date, end_date, rate_term, rate_amount, deposit_amount')
        .eq('id', matchResult.assignment_id)
        .single();

      if (assignmentData?.rate_term === 'monthly') {
        const pd = new Date(paymentDate + 'T12:00:00');
        const year = pd.getFullYear();
        const month = pd.getMonth();
        const lastDay = new Date(year, month + 1, 0).getDate();
        periodStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
        periodEnd = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      } else if (assignmentData?.rate_term === 'weekly' || assignmentData?.rate_term === 'biweekly') {
        const intervalDays = assignmentData.rate_term === 'weekly' ? 7 : 14;
        const pd = new Date(paymentDate + 'T12:00:00');
        const start = new Date(assignmentData.start_date + 'T12:00:00');
        // Find the period that contains the payment date
        const cursor = new Date(start);
        while (cursor <= pd) {
          const next = new Date(cursor);
          next.setDate(next.getDate() + intervalDays);
          if (pd < next) {
            periodStart = cursor.toISOString().split('T')[0];
            const end = new Date(next);
            end.setDate(end.getDate() - 1);
            periodEnd = end.toISOString().split('T')[0];
            break;
          }
          cursor.setDate(cursor.getDate() + intervalDays);
        }
      }

      // Infer payment category from amount vs assignment details
      let inferredCategory = 'rent';
      const paymentStr = payment_string.toLowerCase();
      if (paymentStr.includes('deposit') || paymentStr.includes('security')) {
        inferredCategory = paymentStr.includes('move') ? 'move_in_deposit' : 'security_deposit';
      } else if (assignmentData?.deposit_amount && parsed.amount === assignmentData.deposit_amount) {
        // Amount exactly matches deposit — check if it's early in tenancy (within 7 days of start)
        const startDate = new Date(assignmentData.start_date + 'T12:00:00');
        const pDate = new Date(paymentDate + 'T12:00:00');
        const daysSinceStart = (pDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceStart <= 7) {
          inferredCategory = 'security_deposit';
        }
      } else if (assignmentData?.rate_amount && parsed.amount < assignmentData.rate_amount * 0.95) {
        // Significantly less than full rate — likely prorated
        inferredCategory = 'prorated_rent';
      }
      console.log(`Inferred category: ${inferredCategory} (amount: ${parsed.amount}, rate: ${assignmentData?.rate_amount}, deposit: ${assignmentData?.deposit_amount})`);

      // Dual-write to ledger for accounting (MUST succeed — fail request if not)
      const { error: ledgerError } = await supabase.from('ledger').insert({
        direction: 'income',
        category: inferredCategory,
        amount: parsed.amount,
        payment_method: paymentMethod,
        transaction_date: paymentDate,
        period_start: periodStart,
        period_end: periodEnd,
        person_id: matchResult.person_id,
        person_name: matchResult.person_name,
        assignment_id: matchResult.assignment_id,
        source_payment_id: payment.id,
        status: 'completed',
        description: `${inferredCategory === 'rent' ? 'Rent' : inferredCategory === 'prorated_rent' ? 'Prorated rent' : inferredCategory === 'security_deposit' ? 'Security deposit' : inferredCategory === 'move_in_deposit' ? 'Move-in deposit' : 'Payment'} from ${senderName}`,
        notes: `Auto-recorded from ${source}. Match method: ${matchResult.method}`,
        recorded_by: `system:${source}`,
      });

      if (ledgerError) {
        console.error('CRITICAL: Ledger write failed after payment recorded:', ledgerError);
        // Record the gap for admin review
        if (logEntry) {
          await supabase
            .from('payment_processing_log')
            .update({ status: 'ledger_failed', error_message: `Payment ${payment.id} recorded but ledger failed: ${ledgerError.message}` })
            .eq('id', logEntry.id);
        }
      }

      // Update log with payment ID
      if (logEntry) {
        await supabase
          .from('payment_processing_log')
          .update({ payment_id: payment.id, status: 'success' })
          .eq('id', logEntry.id);
      }

      console.log(`Payment recorded successfully: ${payment.id}`);

      return new Response(
        JSON.stringify({
          success: true,
          payment_id: payment.id,
          match_method: matchResult.method,
          matched_tenant: {
            id: matchResult.person_id,
            name: matchResult.person_name
          },
          parsed_payment: {
            amount: parsed.amount,
            date: paymentDate,
            method: parsed.method
          }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step 5: If not matched, create pending payment for review
    const { data: pendingPayment, error: pendingError } = await supabase
      .from('pending_payments')
      .insert({
        raw_payment_string: payment_string,
        sender_name: senderName,
        parsed_amount: parsed.amount,
        parsed_date: parsed.date?.toISOString().split('T')[0],
        parsed_method: parsed.method,
        gemini_suggestions: matchResult.suggestions,
        processing_log_id: logEntry?.id
      })
      .select()
      .single();

    if (pendingError) {
      console.error('Error creating pending payment:', pendingError);
    }

    // Update log status
    if (logEntry) {
      await supabase
        .from('payment_processing_log')
        .update({ status: 'pending_review' })
        .eq('id', logEntry.id);
    }

    console.log(`Payment sent to manual review: ${pendingPayment?.id}`);

    return new Response(
      JSON.stringify({
        success: false,
        requires_review: true,
        pending_id: pendingPayment?.id,
        parsed_payment: {
          amount: parsed.amount,
          date: parsed.date?.toISOString().split('T')[0],
          method: parsed.method
        },
        suggestions: matchResult.suggestions,
        reasoning: matchResult.reasoning
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Payment processing error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
