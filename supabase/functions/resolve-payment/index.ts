/**
 * Resolve Payment Edge Function
 *
 * Allows admins to manually resolve pending payments that couldn't be
 * automatically matched. Saves the mapping for future payments.
 *
 * Deploy with: supabase functions deploy resolve-payment
 * Endpoint: YOUR_SUPABASE_URL/functions/v1/resolve-payment
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

interface ResolveRequest {
  pending_id: string;
  person_id?: string;
  assignment_id?: string;
  action: 'match' | 'ignore';
  save_mapping?: boolean;
  resolved_by?: string;
}

/**
 * Normalize a name for consistent matching
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '');
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
    const body: ResolveRequest = await req.json();
    const {
      pending_id,
      person_id,
      assignment_id,
      action,
      save_mapping = true,
      resolved_by = 'admin'
    } = body;

    console.log('Resolve payment request:', body);

    if (!pending_id) {
      return new Response(
        JSON.stringify({ success: false, error: 'pending_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!action || !['match', 'ignore'].includes(action)) {
      return new Response(
        JSON.stringify({ success: false, error: 'action must be "match" or "ignore"' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get the pending payment
    const { data: pending, error: pendingError } = await supabase
      .from('pending_payments')
      .select('*')
      .eq('id', pending_id)
      .single();

    if (pendingError || !pending) {
      return new Response(
        JSON.stringify({ success: false, error: 'Pending payment not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (pending.resolved_at) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Pending payment already resolved',
          resolution: pending.resolution
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Handle match action
    if (action === 'match') {
      if (!person_id || !assignment_id) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'person_id and assignment_id are required for match action'
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Record the payment
      const paymentDate =
        pending.parsed_date || new Date().toISOString().split('T')[0];

      // Map parsed method to valid payment_method_type enum values
      const methodMap: Record<string, string> = {
        'zelle': 'zelle',
        'venmo': 'venmo',
        'paypal': 'paypal',
        'check': 'check',
        'cash': 'cash',
        'stripe': 'stripe'
      };
      const paymentMethod = methodMap[pending.parsed_method?.toLowerCase() || ''] || 'other';

      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .insert({
          assignment_id,
          type: 'rent',
          amount_received: pending.parsed_amount,
          received_date: paymentDate,
          payment_method: paymentMethod,
          sender_name: pending.sender_name,
          status: 'paid',
          notes: `Manually matched by ${resolved_by}`
        })
        .select()
        .single();

      if (paymentError) {
        console.error('Error recording payment:', paymentError);
        return new Response(
          JSON.stringify({
            success: false,
            error: `Failed to record payment: ${paymentError.message}`
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Dual-write to ledger for accounting
      // Get person name + assignment details for ledger entry
      const { data: personData } = await supabase
        .from('people')
        .select('first_name, last_name')
        .eq('id', person_id)
        .single();

      const personName = personData ? `${personData.first_name} ${personData.last_name}` : pending.sender_name;

      // Compute rent period from assignment schedule
      let periodStart: string | null = null;
      let periodEnd: string | null = null;
      const { data: assignmentData } = await supabase
        .from('assignments')
        .select('start_date, end_date, rate_term')
        .eq('id', assignment_id)
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

      const { error: ledgerError } = await supabase.from('ledger').insert({
        direction: 'income',
        category: 'rent',
        amount: pending.parsed_amount,
        payment_method: paymentMethod,
        transaction_date: paymentDate,
        period_start: periodStart,
        period_end: periodEnd,
        person_id: person_id,
        person_name: personName,
        assignment_id: assignment_id,
        source_payment_id: payment.id,
        status: 'completed',
        description: `Rent from ${pending.sender_name}`,
        notes: `Manually matched by ${resolved_by}`,
        recorded_by: `system:resolve-payment`,
      });

      if (ledgerError) {
        console.error('CRITICAL: Ledger write failed after payment recorded:', ledgerError);
      }

      // Save mapping for future payments (if requested)
      if (save_mapping && pending.sender_name) {
        const { error: mappingError } = await supabase
          .from('payment_sender_mappings')
          .upsert(
            {
              sender_name: pending.sender_name,
              sender_name_normalized: normalizeName(pending.sender_name),
              person_id,
              confidence_score: 1.0,
              match_source: 'manual',
              updated_at: new Date().toISOString()
            },
            { onConflict: 'sender_name_normalized' }
          );

        if (mappingError) {
          console.error('Error saving mapping:', mappingError);
          // Don't fail the request, mapping is optional
        } else {
          console.log(`Saved mapping: "${pending.sender_name}" → ${person_id}`);
        }
      }

      // Mark pending payment as resolved
      await supabase
        .from('pending_payments')
        .update({
          resolved_at: new Date().toISOString(),
          resolved_by,
          resolution: 'matched'
        })
        .eq('id', pending_id);

      // Update processing log if exists
      if (pending.processing_log_id) {
        await supabase
          .from('payment_processing_log')
          .update({
            payment_id: payment.id,
            matched_person_id: person_id,
            matched_assignment_id: assignment_id,
            status: 'success'
          })
          .eq('id', pending.processing_log_id);
      }

      console.log(`Pending payment ${pending_id} matched to payment ${payment.id}`);

      return new Response(
        JSON.stringify({
          success: true,
          payment_id: payment.id,
          mapping_saved: save_mapping
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Handle ignore action
    if (action === 'ignore') {
      await supabase
        .from('pending_payments')
        .update({
          resolved_at: new Date().toISOString(),
          resolved_by,
          resolution: 'ignored'
        })
        .eq('id', pending_id);

      // Update processing log if exists
      if (pending.processing_log_id) {
        await supabase
          .from('payment_processing_log')
          .update({ status: 'ignored' })
          .eq('id', pending.processing_log_id);
      }

      console.log(`Pending payment ${pending_id} marked as ignored`);

      return new Response(
        JSON.stringify({ success: true, action: 'ignored' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: 'Invalid action' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Resolve payment error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
